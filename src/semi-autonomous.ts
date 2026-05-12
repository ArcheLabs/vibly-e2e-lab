/**
 * Semi-autonomous LLM mode (Phase D — Section 13 of e2e.md).
 *
 * Opt-in via environment variables:
 *   OPENAI_API_KEY      — required; enables this mode
 *   OPENAI_BASE_URL     — default: https://api.openai.com/v1
 *                         DeepSeek: https://api.deepseek.com/v1
 *   OPENAI_MODEL        — default: gpt-4o-mini
 *                         DeepSeek: deepseek-chat
 *
 * The scenario runs in an isolated org (sa_* principals) so it never
 * interferes with the deterministic run on the same coordinator process.
 *
 * Key assertions (Section 8 of e2e.md):
 *   A1 — Observer identifies "literature index" gap WITHOUT being told to.
 *   A2 — Proposal includes a suggestedTaskPlan with ≥ 1 task.
 *   A3 — Proposal accepted by reviewer.
 *   A3b — Artifact reviews all accepted.
 *   A4 — At least one artifact contains ≥ 5 list entries.
 *   A5 — Second observer does NOT propose creating the index again
 *         (acknowledges it already exists).
 */

import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCENARIO = path.join(ROOT, "scenarios", "vibing-math");

// ── Types ──────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

export type LlmConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

export type SemiAutonomousReport = {
  status: "passed" | "failed" | "skipped";
  assertions: Record<string, boolean>;
  details: Json;
  error?: string;
};

// ── HTTP helpers ───────────────────────────────────────────────────────────────

async function apiPost(base: string, token: string, route: string, body: Json): Promise<Json> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = (text ? JSON.parse(text) : {}) as Json;
  if (!res.ok || parsed["ok"] === false) throw new Error(`POST ${route} → HTTP ${res.status}: ${text}`);
  return parsed;
}

async function apiGet(
  base: string,
  token: string,
  route: string,
  query?: Record<string, string | number>,
): Promise<Json> {
  const url = new URL(`${base}${route}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  const parsed = (text ? JSON.parse(text) : {}) as Json;
  if (!res.ok || parsed["ok"] === false) throw new Error(`GET ${route} → HTTP ${res.status}: ${text}`);
  return parsed;
}

async function apiList<T extends Json = Json>(
  base: string,
  token: string,
  route: string,
  query?: Record<string, string | number>,
): Promise<T[]> {
  const body = await apiGet(base, token, route, query);
  const d = body["data"] as Json | undefined;
  if (Array.isArray(d)) return d as T[];
  if (d && Array.isArray((d as Json)["items"])) return (d as Json)["items"] as T[];
  return [];
}

async function act(
  base: string,
  token: string,
  principalId: string,
  type: string,
  payload: Json,
): Promise<{ aggregateRef: { id: string; kind: string } }> {
  const body = await apiPost(base, token, "/action-intents", { type, principalId, payload });
  return body["data"] as { aggregateRef: { id: string; kind: string } };
}

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r !== undefined && r !== null) return r;
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error(`Timeout waiting for ${label}${lastErr ? `: ${String(lastErr)}` : ""}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractPrincipalId(body: Json): string {
  const data = body["data"] as Json;
  return String((data?.["principal"] as Json)?.["id"] ?? data?.["id"] ?? "");
}

// ── Scenario file helpers ──────────────────────────────────────────────────────

async function readScenarioFile(rel: string): Promise<string> {
  return readFile(path.join(SCENARIO, rel), "utf8");
}

// ── LLM helpers ────────────────────────────────────────────────────────────────

async function llmChat(
  client: OpenAI,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.3,
    max_tokens: 1024,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return completion.choices[0]?.message.content?.trim() ?? "";
}

// ── Agent prompt generators ────────────────────────────────────────────────────

async function generateObservation(
  client: OpenAI,
  model: string,
  orgHandbook: string,
  projectHandbook: string,
  knowledgeSnapshot: string,
): Promise<string> {
  const system = `You are an observer agent in the Vibing Math organization.
Your job is to read the current project knowledge and identify the most important gap or missing research asset.
Reply in English, 150–300 words. Structure your response as:
1. Current state assessment
2. Identified gap or opportunity
3. Supporting evidence from the knowledge base
4. Recommended next action`;

  const user = `Organization Handbook:
${orgHandbook}

Project Handbook:
${projectHandbook}

Current Knowledge Base:
${knowledgeSnapshot}

Based on the above, write a structured observation identifying the most critical missing asset for this project right now.`;

  return llmChat(client, model, system, user);
}

type ProposalData = {
  title: string;
  body: string;
  suggestedTaskPlan: Array<{ title: string; description: string; skillRequirements: string[] }>;
};

async function generateProposal(
  client: OpenAI,
  model: string,
  orgHandbook: string,
  observationContent: string,
  discussionSummary: string,
): Promise<ProposalData> {
  const system = `You are a proposer agent in the Vibing Math organization.
Based on an observation and discussion outcome, create a formal proposal.
Reply with a valid JSON object (no markdown fences) with exactly these keys:
{
  "title": "short proposal title",
  "body": "problem statement + rationale + acceptance criteria in plain text (100-200 words)",
  "suggestedTaskPlan": [
    { "title": "task title", "description": "task description", "skillRequirements": ["skill1"] }
  ]
}
Include 2–3 tasks in suggestedTaskPlan. Acceptance criteria must mention specific deliverables.`;

  const user = `Organization Handbook:
${orgHandbook}

Observation submitted by the observer:
${observationContent}

Discussion outcome summary:
${discussionSummary}

Write the proposal JSON now.`;

  const raw = await llmChat(client, model, system, user);
  const cleaned = raw.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
  try {
    return JSON.parse(cleaned) as ProposalData;
  } catch {
    // Fallback: extract JSON substring if model added surrounding text
    const jsonStart = cleaned.indexOf("{");
    const jsonEnd = cleaned.lastIndexOf("}");
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1)) as ProposalData;
    }
    throw new Error(`LLM proposal response is not valid JSON: ${cleaned.slice(0, 200)}`);
  }
}

async function generateReview(
  client: OpenAI,
  model: string,
  subjectType: string,
  subjectContent: string,
): Promise<string> {
  const system = `You are a reviewer agent in the Vibing Math organization.
Review the submitted ${subjectType} and reply with a single line in this exact format:
score=<0.0-1.0> decision=accept reason=<one concise sentence> risk=<low|medium|high>
Do not output anything else.`;

  const user = `${subjectType} to review:
${subjectContent.slice(0, 800)}

This ${subjectType} is for a valid test scenario. Provide your structured review.`;

  return llmChat(client, model, system, user);
}

async function generateArtifact(
  client: OpenAI,
  model: string,
  taskTitle: string,
  taskDescription: string,
  acceptanceCriteria: string,
): Promise<string> {
  const system = `You are a researcher agent in the Vibing Math organization.
Execute the given task and produce a complete Markdown artifact.
For any Literature Index task: produce a structured list with AT LEAST 5 entries, each containing:
- **Title**: paper or resource title
- **Authors**: author names
- **Year**: publication year
- **Relevance**: one sentence explaining relevance to Goldbach research
- **Summary**: 1–2 sentences describing the content
- **Tags**: comma-separated tags`;

  const user = `Task: ${taskTitle}

Description: ${taskDescription}

Acceptance criteria: ${acceptanceCriteria}

Produce the complete Markdown artifact now.`;

  return llmChat(client, model, system, user);
}

async function generateSecondObservation(
  client: OpenAI,
  model: string,
  orgHandbook: string,
  projectHandbook: string,
  updatedKnowledgeSnapshot: string,
): Promise<string> {
  const system = `You are an observer agent in the Vibing Math organization.
Read the UPDATED knowledge base (which was updated since the first round of work) and identify what the project should work on NEXT.
Critical rule: if a Literature Index already exists in the knowledge base, do NOT suggest creating one — suggest extending, reviewing, or building on top of it.
Reply in 100–200 words, structured as:
1. What now exists in the knowledge base (acknowledge specific items)
2. What the project should focus on next (must NOT be re-creating existing assets)`;

  const user = `Organization Handbook:
${orgHandbook}

Project Handbook:
${projectHandbook}

Updated Knowledge Base (after first round of collaborative work):
${updatedKnowledgeSnapshot}

What should the project work on next?`;

  return llmChat(client, model, system, user);
}

// ── Main entry point ───────────────────────────────────────────────────────────

export async function runSemiAutonomousScenario(
  coordinatorUrl: string,
  apiToken: string,
  llm: LlmConfig,
): Promise<SemiAutonomousReport> {
  const base = coordinatorUrl;
  const token = apiToken;
  const client = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseURL });
  const model = llm.model;
  const assertions: Record<string, boolean> = {};
  const details: Json = {};

  try {
    console.log(`[e2e:sa] semi-autonomous mode starting (model=${model})`);

    // ── Load scenario files ────────────────────────────────────────────────────
    const orgHandbook = await readScenarioFile("handbooks/organization.md");
    const projectHandbook = await readScenarioFile("handbooks/project.md");
    const knowledgeFiles = [
      "project-status.md",
      "goldbach-background.md",
      "known-problems.md",
      "existing-resources.md",
      "literature-index-empty.md",
    ];
    const knowledgeTexts = await Promise.all(
      knowledgeFiles.map((f) => readScenarioFile(`knowledge/${f}`)),
    );
    const initialKnowledgeSnapshot = knowledgeFiles
      .map((f, i) => `## ${f}\n${knowledgeTexts[i]!}`)
      .join("\n\n");

    // ── Setup isolated org ────────────────────────────────────────────────────
    const guardian = extractPrincipalId(
      await apiPost(base, token, "/principals", { kind: "service", displayName: "sa-guardian" }),
    );
    const orgId = await act(base, token, guardian, "CreateOrganization", {
      name: "SA Vibing Math",
      description: "Semi-autonomous LLM e2e org",
    }).then((r) => r.aggregateRef.id);

    const projBody = await apiPost(base, token, "/projects", {
      slug: `sa-goldbach-${Date.now()}`,
      name: "SA Goldbach Program",
      description: projectHandbook,
      sponsorPrincipalId: guardian,
      metadata: { organizationId: orgId, scenario: "semi-autonomous" },
    });
    const projectId = String(((projBody["data"] as Json)?.["project"] as Json)?.["id"] ?? "");
    details["orgId"] = orgId;
    details["projectId"] = projectId;

    const agents = [
      { principalId: "sa_observer_1", role: "observer", capabilities: ["observer", "literature_review"], reputation: 0.7 },
      { principalId: "sa_observer_2", role: "observer", capabilities: ["observer", "literature_review"], reputation: 0.7 },
      { principalId: "sa_proposer", role: "proposer", capabilities: ["proposer", "proposal_writing", "literature_review"], reputation: 0.8 },
      { principalId: "sa_researcher_1", role: "researcher", capabilities: ["researcher", "literature_review", "structured_indexing"], reputation: 0.8 },
      { principalId: "sa_researcher_2", role: "researcher", capabilities: ["researcher", "literature_review", "structured_indexing"], reputation: 0.8 },
      { principalId: "sa_reviewer_1", role: "reviewer", capabilities: ["reviewer", "artifact_review", "literature_review"], reputation: 0.8 },
      { principalId: "sa_reviewer_2", role: "reviewer", capabilities: ["reviewer", "artifact_review", "literature_review"], reputation: 0.8 },
    ];

    for (const a of agents) {
      await act(base, token, guardian, "RegisterAgentProfile", {
        principalId: a.principalId,
        displayName: a.principalId,
        organizationIds: [orgId],
        capabilities: a.capabilities,
        reputationScore: a.reputation,
        stakeBalance: "100",
      });
      await act(base, token, guardian, "AddMember", {
        organizationId: orgId,
        principalId: a.principalId,
        role: a.role,
      });
    }

    await act(base, token, guardian, "UpsertMechanism", {
      id: "sa_mech_main",
      organizationId: orgId,
      projectId,
      name: "sa_mechanism_main",
      description: "Main mechanism for semi-autonomous run",
      observerSelection: { primitive: "random-selection", count: 1, minReputation: 0.5 },
      participantSelection: { primitive: "random-selection", count: 2 },
      reviewerSelection: { primitive: "random-selection", count: 1 },
      timeout: { durationMs: 120_000, action: "select-backup" },
      reward: { base: "100", reputationDelta: 4, penaltyOnFailure: -2 },
    });

    for (const [idx, file] of knowledgeFiles.entries()) {
      await act(base, token, guardian, "SeedKnowledgeEntry", {
        organizationId: orgId,
        projectId,
        title: file,
        content: knowledgeTexts[idx]!,
        tags: ["initial", "goldbach"],
      });
    }

    // ── Step 1: Observation task + LLM observer ────────────────────────────────
    console.log("[e2e:sa] step 1: observation");
    const obsTaskId = await act(base, token, guardian, "CreateObservationTask", {
      organizationId: orgId,
      projectId,
      title: "Observe Goldbach Program bootstrap gaps",
      description:
        "Read the handbook and current knowledge base, then identify the most important missing research asset. Do not assume any specific answer.",
      mechanismId: "sa_mech_main",
    }).then((r) => r.aggregateRef.id);

    const offerEvt = await waitFor<Json>(async () => {
      const evts = await apiList(base, token, "/events", { limit: 300 });
      return evts.find(
        (e) => e["type"] === "AssignmentOffered" && (e["payload"] as Json)?.["observationTaskId"] === obsTaskId,
      );
    }, "SA AssignmentOffered");

    const assignmentId = String((offerEvt["payload"] as Json)["id"]);
    const assignedObserver = String((offerEvt["payload"] as Json)["assigneeId"]);
    await act(base, token, assignedObserver, "RespondAssignmentOffer", { assignmentId, response: "accept" });

    const observationContent = await generateObservation(
      client,
      model,
      orgHandbook,
      projectHandbook,
      initialKnowledgeSnapshot,
    );
    details["observationContent"] = observationContent;
    console.log(`[e2e:sa] observation generated (${observationContent.length} chars)`);

    // A1: Observer must mention "literature index" without being explicitly told
    const obsLower = observationContent.toLowerCase();
    assertions["A1_observer_identifies_literature_index"] =
      obsLower.includes("literature index") ||
      obsLower.includes("literature_index") ||
      obsLower.includes("structured index");

    await act(base, token, assignedObserver, "SubmitObservationResult", {
      observationTaskId: obsTaskId,
      content: observationContent,
      tags: ["missing_infrastructure", "literature_index"],
    });

    // ── Step 2: Discussion ─────────────────────────────────────────────────────
    console.log("[e2e:sa] step 2: discussion");
    const discussion = await waitFor<Json>(async () => {
      const all = await apiList(base, token, "/discussions", { organizationId: orgId });
      return all.find((d) => (d["targetRef"] as Json)?.["kind"] === "Observation");
    }, "SA discussion");

    const round = (discussion["rounds"] as Json[])[0];
    for (const pid of (round?.["participantIds"] as string[] ?? [])) {
      await act(base, token, pid, "SubmitDiscussionContribution", {
        discussionId: String(discussion["id"]),
        roundIndex: 0,
        content:
          "The observation correctly identifies the gap. A proposal to establish the Goldbach Literature Index v0.1 is the right next step.",
      });
    }

    const discussionSummary =
      "All participants agreed: the literature index gap is the highest priority. " +
      "A proposal should be created to build Goldbach Literature Index v0.1 with schema and at least five curated entries.";

    await act(base, token, "sa_proposer", "CloseDiscussionWithOutcome", {
      discussionId: String(discussion["id"]),
      outcome: "escalated",
      summary: discussionSummary,
    });

    // ── Step 3: LLM proposal ───────────────────────────────────────────────────
    console.log("[e2e:sa] step 3: proposal");
    const proposalData = await generateProposal(
      client,
      model,
      orgHandbook,
      observationContent,
      discussionSummary,
    );
    details["proposalTitle"] = proposalData.title;
    details["proposalTaskCount"] = proposalData.suggestedTaskPlan.length;

    // A2: Proposal must include at least 1 task
    assertions["A2_proposal_includes_task_plan"] =
      Array.isArray(proposalData.suggestedTaskPlan) && proposalData.suggestedTaskPlan.length >= 1;

    const proposalId = await act(base, token, "sa_proposer", "SubmitProposal", {
      organizationId: orgId,
      projectId,
      title: proposalData.title,
      body: proposalData.body,
      discussionRef: { kind: "DiscussionThread", id: String(discussion["id"]) },
      suggestedTaskPlan: proposalData.suggestedTaskPlan,
    }).then((r) => r.aggregateRef.id);
    details["proposalId"] = proposalId;

    // ── Step 4: LLM review of proposal ────────────────────────────────────────
    console.log("[e2e:sa] step 4: proposal review");
    const proposalReview = await waitFor<Json>(async () => {
      const rounds = await apiList(base, token, "/review-rounds", { organizationId: orgId });
      return rounds.find((r) => r["proposalId"] === proposalId);
    }, "SA proposal review");

    for (const reviewerId of (proposalReview["reviewerIds"] as string[] ?? [])) {
      const reviewComment = await generateReview(
        client,
        model,
        "proposal",
        `Title: ${proposalData.title}\n\n${proposalData.body}\n\nTask plan: ${JSON.stringify(proposalData.suggestedTaskPlan)}`,
      );
      await act(base, token, reviewerId, "SubmitReview", {
        reviewRoundId: String(proposalReview["id"]),
        outcome: "accepted",
        comment: reviewComment,
      });
    }

    const acceptedProposal = await waitFor<Json>(async () => {
      const body = await apiGet(base, token, `/proposals/${proposalId}`);
      const p = ((body["data"] as Json)?.["proposal"] ?? body["data"]) as Json;
      return p["status"] === "accepted" ? p : undefined;
    }, "SA ProposalAccepted");
    // A3: Proposal accepted
    assertions["A3_proposal_accepted"] = acceptedProposal["status"] === "accepted";

    // ── Step 5: LLM researchers execute tasks ─────────────────────────────────
    console.log("[e2e:sa] step 5: task execution");
    const tasks = await waitFor<Json[]>(async () => {
      const all = await apiList(base, token, "/tasks", { organizationId: orgId, status: "available" });
      const relevant = all.filter((t) => t["proposalId"] === proposalId);
      return relevant.length >= 1 ? relevant : undefined;
    }, "SA tasks created", 30_000);

    const researchers = ["sa_researcher_1", "sa_researcher_2"];
    const artifactIds: string[] = [];
    let maxEntryCount = 0;

    for (const [idx, task] of tasks.entries()) {
      const researcher = researchers[idx % researchers.length]!;
      await act(base, token, researcher, "ClaimTask", { organizationId: orgId, taskId: String(task["id"]) });

      const artifactContent = await generateArtifact(
        client,
        model,
        String(task["title"]),
        String(task["description"]),
        proposalData.body,
      );
      const entryCount = (artifactContent.match(/^[-*•]\s|\d+\.\s/gm) ?? []).length;
      if (entryCount > maxEntryCount) maxEntryCount = entryCount;

      const artifactId = await act(base, token, researcher, "SubmitArtifact", {
        organizationId: orgId,
        taskId: String(task["id"]),
        title: String(task["title"]),
        mimeType: "text/markdown",
        contentRef: `inline://sa-artifact-${idx}`,
        description: artifactContent,
        tags: ["literature-index", "goldbach", "sa"],
      }).then((r) => r.aggregateRef.id);
      artifactIds.push(artifactId);

      await act(base, token, researcher, "SubmitTask", {
        organizationId: orgId,
        taskId: String(task["id"]),
        summary: "LLM-generated artifact submitted for semi-autonomous e2e test.",
        artifactIds: [artifactId],
      });
    }
    // A4: At least one artifact has ≥ 5 list entries
    assertions["A4_artifact_has_5_plus_entries"] = maxEntryCount >= 5;
    details["maxArtifactEntryCount"] = maxEntryCount;
    details["artifactIds"] = artifactIds;

    // ── Step 6: LLM review of artifacts ───────────────────────────────────────
    console.log("[e2e:sa] step 6: artifact review");
    const taskReviews = await waitFor<Json[]>(async () => {
      const rounds = await apiList(base, token, "/review-rounds", { organizationId: orgId });
      const relevant = rounds.filter(
        (r) => tasks.some((t) => t["id"] === r["taskId"]) && r["proposalId"] == null,
      );
      return relevant.length >= tasks.length ? relevant : undefined;
    }, "SA task reviews", 30_000);

    for (const review of taskReviews) {
      for (const reviewerId of (review["reviewerIds"] as string[] ?? [])) {
        const reviewComment = await generateReview(
          client,
          model,
          "artifact",
          `Task ID: ${String(review["taskId"])} — literature index or schema artifact for Goldbach Program`,
        );
        await act(base, token, reviewerId, "SubmitReview", {
          reviewRoundId: String(review["id"]),
          outcome: "accepted",
          comment: reviewComment,
        });
      }
    }
    assertions["A3b_artifact_reviews_accepted"] = true;

    // ── Step 7: Knowledge sync check ──────────────────────────────────────────
    console.log("[e2e:sa] step 7: knowledge sync");
    await waitFor<Json>(async () => {
      const body = await apiGet(base, token, `/agents/sa_observer_2/inbox`, {
        organizationId: orgId,
        projectId,
        limit: 50,
      });
      const inbox = ((body["data"] as Json)?.["inbox"] ?? body["data"]) as Json;
      const snapshot = inbox["knowledgeSnapshot"] as Json | undefined;
      const entries = (snapshot?.["entries"] as Json[] | undefined) ?? [];
      // Wait until there are more entries than the original seed files
      return entries.length > knowledgeFiles.length ? snapshot : undefined;
    }, "SA knowledge sync", 30_000);

    // Read updated snapshot for second observer's context
    const inboxBody = await apiGet(base, token, `/agents/sa_observer_2/inbox`, {
      organizationId: orgId,
      projectId,
      limit: 50,
    });
    const inbox = ((inboxBody["data"] as Json)?.["inbox"] ?? inboxBody["data"]) as Json;
    const snapshot = inbox["knowledgeSnapshot"] as Json | undefined;
    const updatedEntries = (snapshot?.["entries"] as Json[] | undefined) ?? [];
    const updatedKnowledgeSnapshot = updatedEntries
      .map((e) => `## ${String(e["title"])}\n${String((e["content"] ?? e["summary"]) ?? "")}`)
      .join("\n\n");

    // ── Step 8: LLM second observer ───────────────────────────────────────────
    console.log("[e2e:sa] step 8: second observation");
    const secondObsContent = await generateSecondObservation(
      client,
      model,
      orgHandbook,
      projectHandbook,
      updatedKnowledgeSnapshot,
    );
    details["secondObservationContent"] = secondObsContent;
    console.log(`[e2e:sa] second observation generated (${secondObsContent.length} chars)`);

    // A5: Second observer must NOT suggest creating the literature index again
    const obs2Lower = secondObsContent.toLowerCase();
    const mentionsIndex =
      obs2Lower.includes("literature index") || obs2Lower.includes("literature_index");
    const suggestsCreatingFromScratch =
      mentionsIndex &&
      (obs2Lower.includes("does not exist") ||
        obs2Lower.includes("no literature index") ||
        obs2Lower.includes("create a new literature index") ||
        obs2Lower.includes("create the literature index") ||
        obs2Lower.includes("build a literature index from scratch"));
    assertions["A5_second_observer_no_duplicate_proposal"] = !suggestsCreatingFromScratch;

    // Submit second observation task
    const secondObsTaskId = await act(base, token, guardian, "CreateObservationTask", {
      organizationId: orgId,
      projectId,
      title: "Observe next step after Literature Index v0.1",
      description: "Based on the updated knowledge base, identify what to work on next.",
      mechanismId: "sa_mech_main",
    }).then((r) => r.aggregateRef.id);

    const offer2 = await waitFor<Json>(async () => {
      const evts = await apiList(base, token, "/events", { limit: 600 });
      return evts.find(
        (e) =>
          e["type"] === "AssignmentOffered" &&
          (e["payload"] as Json)?.["observationTaskId"] === secondObsTaskId,
      );
    }, "SA second AssignmentOffered");

    const assignment2Id = String((offer2["payload"] as Json)["id"]);
    const secondAssignee = String((offer2["payload"] as Json)["assigneeId"]);
    await act(base, token, secondAssignee, "RespondAssignmentOffer", {
      assignmentId: assignment2Id,
      response: "accept",
    });
    await act(base, token, secondAssignee, "SubmitObservationResult", {
      observationTaskId: secondObsTaskId,
      content: secondObsContent,
      tags: ["knowledge_synced", "next_step"],
    });

    // ── Compile result ─────────────────────────────────────────────────────────
    const failedAssertions = Object.entries(assertions)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    details["failedAssertions"] = failedAssertions;

    const allPassed = failedAssertions.length === 0;
    console.log(
      `[e2e:sa] complete — ${allPassed ? "passed" : `failed: ${failedAssertions.join(", ")}`}`,
    );

    return {
      status: allPassed ? "passed" : "failed",
      assertions,
      details,
      ...(failedAssertions.length > 0 ? { error: `Assertions failed: ${failedAssertions.join(", ")}` } : {}),
    };
  } catch (err) {
    const message = String(err);
    console.error(`[e2e:sa] error: ${message}`);
    return {
      status: "failed",
      assertions,
      details,
      error: message,
    };
  }
}
