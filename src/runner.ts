import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { runFailureScenarios } from "./failure-scenarios.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCENARIO = path.join(ROOT, "scenarios", "vibing-math");
const REPORT_DIR = path.join(ROOT, "reports");
const DATA_DIR = path.join(ROOT, "data");
const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const CONSOLE_PORT = Number(process.env.VIBLY_E2E_CONSOLE_PORT ?? "3001");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? `http://127.0.0.1:${COORDINATOR_PORT}`;
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";

type AgentConfig = {
  id: string;
  principalId: string;
  roleHints: string[];
  skills: Record<string, number>;
  behavior: Record<string, unknown>;
};

type MechanismConfig = Record<string, unknown> & { id: string; name: string };

type Json = Record<string, unknown>;

const children: ChildProcessWithoutNullStreams[] = [];

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  const coordinator = await startCoordinator();
  let consoleProcess: ChildProcessWithoutNullStreams | undefined;
  if (process.env.VIBLY_E2E_SKIP_CONSOLE !== "true") {
    consoleProcess = await startConsole().catch((err) => {
      console.warn(`[e2e] console unavailable, API flow will continue: ${String(err)}`);
      return undefined;
    });
  }

  try {
    const trace = await runDeterministicScenario();
    if (consoleProcess) await smokeConsole(String(trace.projectId));

    const failureReport = await runFailureScenarios({
      coordinatorUrl: COORDINATOR_URL,
      apiToken: API_TOKEN,
      mainOrgId: String(trace.organizationId),
      mainProjectId: String(trace.projectId),
    });

    const ts = Date.now();
    const reportPath = path.join(REPORT_DIR, `deterministic-${ts}.json`);
    await writeFile(reportPath, JSON.stringify({ ...trace, failureScenarios: failureReport }, null, 2));
    console.log(`[e2e] deterministic scenario passed. report=${reportPath}`);
    const failedFCs = (["fc1", "fc2", "fc3", "fc4", "fc5"] as const).filter((k) => failureReport[k] !== "passed");
    if (failedFCs.length > 0) {
      console.warn(`[e2e] failure scenarios not all passed: ${failedFCs.join(", ")}`);
    } else {
      console.log("[e2e] all failure scenarios passed.");
    }
  } finally {
    await stopChildren();
    coordinator.kill("SIGTERM");
    consoleProcess?.kill("SIGTERM");
  }
}

async function runDeterministicScenario(): Promise<Json> {
  const agents = await loadYaml<{ agents: AgentConfig[] }>("agents.yaml");
  const mechanisms = await loadYaml<{ mechanisms: MechanismConfig[] }>("mechanisms.yaml");
  const orgHandbook = await readScenarioFile("handbooks/organization.md");
  const projectHandbook = await readScenarioFile("handbooks/project.md");
  const knowledgeFiles = [
    "project-status.md",
    "goldbach-background.md",
    "known-problems.md",
    "existing-resources.md",
    "literature-index-empty.md",
  ];

  const guardianPrincipal = await post("/principals", { kind: "service", displayName: "human-guardian" })
    .then((body) => unwrapKey<Json>(body, "principal"));
  const guardian = String(guardianPrincipal.id);
  const orgId = await action("CreateOrganization", guardian, {
    name: "Vibing Math",
    description: "Local deterministic multi-agent E2E organization",
  }).then((result) => result.aggregateRef.id);

  await action("UpdateHandbook", guardian, {
    organizationId: orgId,
    handbook: {
      mission: orgHandbook,
      principles: [
        "Use ActionIntent for all state changes",
        "Build reusable research infrastructure before proof attempts",
      ],
      guardianPolicy: { guardian: guardian, powers: ["pause", "veto", "request_revision"] },
    },
  });

  const project = await post("/projects", {
    slug: "goldbach-program",
    name: "Goldbach Program",
    description: projectHandbook,
    sponsorPrincipalId: guardian,
    metadata: { organizationId: orgId, scenario: "vibing-math" },
  }).then((body) => unwrapKey<Json>(body, "project"));
  const projectId = String(project.id);

  for (const agent of agents.agents) {
    const capabilities = [...new Set([...agent.roleHints, ...Object.keys(agent.skills)])];
    const reputationScore = agent.id === "lazy-agent" ? 0.1 : 0.7;
    await action("RegisterAgentProfile", guardian, {
      principalId: agent.principalId,
      displayName: agent.id,
      organizationIds: [orgId],
      capabilities,
      reputationScore,
      stakeBalance: "100",
    });
    await action("AddMember", guardian, {
      organizationId: orgId,
      principalId: agent.principalId,
      role: agent.roleHints[0] ?? "agent",
    });
  }

  for (const mechanism of mechanisms.mechanisms) {
    await action("UpsertMechanism", guardian, { ...mechanism, organizationId: orgId, projectId });
  }

  for (const file of knowledgeFiles) {
    await action("SeedKnowledgeEntry", guardian, {
      organizationId: orgId,
      projectId,
      title: file,
      content: await readScenarioFile(`knowledge/${file}`),
      tags: ["initial", "goldbach"],
    });
  }

  const observationTaskId = await action("CreateObservationTask", guardian, {
    organizationId: orgId,
    projectId,
    title: "Observe Goldbach Program bootstrap gaps",
    description: "Read the handbook and current knowledge, then identify the most important missing research asset.",
    mechanismId: "mechanism_vibing_math_main",
  }).then((result) => result.aggregateRef.id);

  const observer = await findAssignee(observationTaskId, agents.agents);
  await action("RespondAssignmentOffer", observer.principalId, {
    assignmentId: observer.assignmentId,
    response: "accept",
  });
  await action("SubmitObservationResult", observer.principalId, {
    observationTaskId,
    tags: ["missing_infrastructure", "literature_index"],
    content: [
      "Current project status says bootstrap work should build reusable research infrastructure.",
      "The knowledge base explicitly says no structured Literature Index exists yet.",
      "A Goldbach Literature Index v0.1 is the right next asset before proof attempts.",
      "Suggested next action: create a proposal and task plan for literature schema and initial index entries.",
    ].join("\n"),
  });

  const discussion = await waitFor<Json>(() => list<Json>("/discussions", { organizationId: orgId })
    .then((items) => items.find((item) => item.targetRef && (item.targetRef as Json).kind === "Observation")), "discussion");
  const round = (discussion.rounds as Json[])[0]!;
  for (const principalId of round.participantIds as string[]) {
    await action("SubmitDiscussionContribution", principalId, {
      discussionId: discussion.id,
      roundIndex: 0,
      content: "I agree the literature index should be created first, with schema, source entries, and review criteria.",
    });
  }
  await action("CloseDiscussionWithOutcome", "principal_proposer", {
    discussionId: discussion.id,
    outcome: "escalated",
    summary: "Create a proposal for Goldbach Literature Index v0.1.",
  });

  const proposalRequestSeen = await waitFor<Json>(() => getInbox("principal_proposer", orgId, projectId)
    .then((inbox) => (inbox.notifications as Json[]).find((item) => item.type === "ProposalCreationRequest")), "proposal request", 3_000)
    .then(() => true)
    .catch(() => false);

  const proposalId = await action("SubmitProposal", "principal_proposer", {
    organizationId: orgId,
    projectId,
    title: "Establish Goldbach Literature Index v0.1",
    body: [
      "Problem: Goldbach Program lacks a structured literature index.",
      "Rationale: the handbook prioritizes reusable research assets before proof attempts.",
      "Acceptance: produce a schema and at least five curated literature entries.",
      "Reward budget: 100 DOT mock settlement.",
    ].join("\n"),
    discussionRef: { kind: "DiscussionThread", id: discussion.id },
    suggestedTaskPlan: [
      {
        title: "Literature Schema Design Task",
        description: "Define fields for title, authors, year, relevance, summary, and tags.",
        skillRequirements: ["literature_review"],
      },
      {
        title: "Literature Index Creation Task",
        description: "Create Literature Index v0.1 with at least five fixture entries.",
        skillRequirements: ["literature_review", "structured_indexing"],
      },
    ],
  }).then((result) => result.aggregateRef.id);

  const proposalReview = await waitFor<Json>(() => list<Json>("/review-rounds", { organizationId: orgId })
    .then((items) => items.find((item) => item.proposalId === proposalId)), "proposal review");
  for (const reviewerId of proposalReview.reviewerIds as string[]) {
    await action("SubmitReview", reviewerId, {
      reviewRoundId: proposalReview.id,
      outcome: "accepted",
      comment: "score=0.92 decision=accept reason=clear task plan and acceptance criteria risk=low",
    });
  }

  await waitFor<Json>(() => get<Json>(`/proposals/${proposalId}`).then((body) => unwrapKey<Json>(body, "proposal"))
    .then((item) => item.status === "accepted" ? item : undefined), "accepted proposal");

  const tasks = await waitFor<Json[]>(() => list<Json>("/tasks", { organizationId: orgId, status: "available" })
    .then((items) => items.filter((item) => item.proposalId === proposalId).length >= 2 ? items.filter((item) => item.proposalId === proposalId) : undefined), "proposal tasks");

  const researchers = ["principal_researcher_1", "principal_researcher_2"];
  const artifactIds: string[] = [];
  for (const [index, task] of tasks.entries()) {
    const researcher = researchers[index % researchers.length]!;
    await action("ClaimTask", researcher, { organizationId: orgId, taskId: task.id });
    const artifactId = await action("SubmitArtifact", researcher, {
      organizationId: orgId,
      taskId: task.id,
      title: index === 0 ? "Goldbach Literature Schema v0.1" : "Goldbach Literature Index v0.1",
      mimeType: "text/markdown",
      contentRef: `inline://goldbach-literature-${index}`,
      description: index === 0 ? schemaArtifact() : literatureIndexArtifact(),
      tags: ["literature-index", "goldbach"],
    }).then((result) => result.aggregateRef.id);
    artifactIds.push(artifactId);
    await action("SubmitTask", researcher, {
      organizationId: orgId,
      taskId: task.id,
      summary: "Submitted deterministic fixture artifact for E2E validation.",
      artifactIds: [artifactId],
    });
  }

  const taskReviews = await waitFor<Json[]>(() => list<Json>("/review-rounds", { organizationId: orgId })
    .then((items) => {
      const rounds = items.filter((item) => tasks.some((task) => task.id === item.taskId));
      return rounds.length >= tasks.length ? rounds : undefined;
    }), "task reviews");
  for (const review of taskReviews) {
    for (const reviewerId of review.reviewerIds as string[]) {
      await action("SubmitReview", reviewerId, {
        reviewRoundId: review.id,
        outcome: "accepted",
        comment: "decision=accept reason=artifact satisfies the schema and index acceptance criteria risk=low",
      });
    }
  }

  await waitFor<Json[]>(() => list<Json>("/artifacts", { organizationId: orgId })
    .then((items) => artifactIds.every((id) => items.some((item) => item.id === id && item.status === "merged")) ? items : undefined), "merged artifacts");
  await waitFor<Json[]>(() => getInbox("principal_observer_2", orgId, projectId)
    .then((inbox) => {
      const entries = (inbox.knowledgeSnapshot as Json).entries as Json[];
      return entries.some((entry) => String(entry.title).includes("Literature Index")) ? entries : undefined;
    }), "knowledge sync");
  await waitFor<Json[]>(() => list<Json>("/reward-intents", { organizationId: orgId })
    .then((items) => items.some((item) => item.status === "settled") ? items : undefined), "settled reward");
  await waitFor<Json[]>(() => list<Json>("/settlement-batches", { organizationId: orgId })
    .then((items) => items.some((item) => item.status === "confirmed") ? items : undefined), "confirmed settlement");
  await waitFor<Json[]>(() => list<Json>("/reputation/events", { organizationId: orgId })
    .then((items) => items.length > 0 ? items : undefined), "reputation events");

  const secondTaskId = await action("CreateObservationTask", guardian, {
    organizationId: orgId,
    projectId,
    title: "Observe next step after Literature Index v0.1",
    description: "Verify the next observation uses updated knowledge.",
    mechanismId: "mechanism_vibing_math_main",
  }).then((result) => result.aggregateRef.id);
  await action("SubmitObservationResult", "principal_observer_2", {
    observationTaskId: secondTaskId,
    tags: ["knowledge_synced", "next_step"],
    content: "Literature Index v0.1 now exists in the project knowledge snapshot. Next work should expand it to 20 entries and add a proof-attempt taxonomy, not recreate the first index.",
  });

  const events = await list<Json>("/events", { limit: 200 });
  assertEventTypes(events, [
    "ObservationTaskCreated",
    "AssignmentOffered",
    "AssignmentAccepted",
    "ObservationSubmitted",
    "DiscussionRoundCreated",
    "DiscussionOutcomeRecorded",
    "ProposalSubmitted",
    "ProposalAccepted",
    "TaskCreated",
    "ArtifactSubmitted",
    "ArtifactAccepted",
    "RewardIntentCreated",
    "SettlementConfirmed",
    "KnowledgeEntryUpdated",
  ]);

  return {
    mode: "deterministic",
    organizationId: orgId,
    projectId,
    proposalId,
    taskIds: tasks.map((task) => task.id),
    artifactIds,
    proposalRequestSeen,
    eventTypes: events.map((event) => event.type),
  };
}

async function startCoordinator(): Promise<ChildProcessWithoutNullStreams> {
  if (process.env.VIBLY_E2E_EXTERNAL_COORDINATOR === "true") {
    await waitForHealth(COORDINATOR_URL);
    return fakeChild();
  }
  const dbPath = path.join(DATA_DIR, "vibly-e2e-coordinator.sqlite");
  if (existsSync(dbPath)) await rm(dbPath, { force: true });
  const child = spawn("pnpm", ["--dir", path.resolve(ROOT, "../vibly-coordinator"), "dev"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(COORDINATOR_PORT),
      HOST: "127.0.0.1",
      API_AUTH_MODE: "static-token",
      API_TOKENS: API_TOKEN,
      STORAGE_MODE: "sqlite",
      DATABASE_URL: `file:${dbPath}`,
      ENABLE_DEV_ROUTES: "true",
      LOG_LEVEL: "warn",
      GOVERNANCE_BACKENDS: "",
    },
    stdio: "pipe",
  });
  pipeChild("coordinator", child);
  children.push(child);
  await waitForHealth(COORDINATOR_URL);
  return child;
}

async function startConsole(): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn("pnpm", ["--dir", path.resolve(ROOT, "../vibly-console"), "dev", "--", "-p", String(CONSOLE_PORT)], {
    env: {
      ...process.env,
      COORDINATOR_URL,
      COORDINATOR_API_TOKEN: API_TOKEN,
      AUTH_SECRET: "vibly-e2e-local-secret",
      AUTH_DEV_CREDENTIALS: "true",
      PORT: String(CONSOLE_PORT),
    },
    stdio: "pipe",
  });
  pipeChild("console", child);
  children.push(child);
  await waitForHttp(`http://127.0.0.1:${CONSOLE_PORT}/login`, 60_000);
  return child;
}

async function smokeConsole(projectId: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/login`);
  if (!response.ok) throw new Error(`Console smoke failed: HTTP ${response.status}`);
  console.log(`[e2e] console smoke passed for project ${projectId}`);
}

async function action(type: string, principalId: string, payload: Json): Promise<{ aggregateRef: { id: string; kind: string } }> {
  const body = await post("/action-intents", { type, principalId, payload });
  return unwrapData<{ aggregateRef: { id: string; kind: string } }>(body);
}

async function getInbox(principalId: string, organizationId: string, projectId: string): Promise<Json> {
  const body = await get<Json>(`/agents/${principalId}/inbox`, { organizationId, projectId, limit: 100 });
  return unwrapKey<Json>(body, "inbox");
}

async function findAssignee(observationTaskId: string, agents: AgentConfig[]): Promise<{ principalId: string; assignmentId: string }> {
  return waitFor(async () => {
    for (const agent of agents) {
      const body = await get<Json>(`/agents/${agent.principalId}/inbox`, { limit: 20 });
      const inbox = unwrapKey<Json>(body, "inbox");
      const offer = (inbox.assignmentOffers as Json[]).find((item) => item.observationTaskId === observationTaskId);
      if (offer) return { principalId: agent.principalId, assignmentId: String(offer.id) };
    }
    return undefined;
  }, "assignment offer");
}

async function post(route: string, body: Json): Promise<Json> {
  const response = await fetch(`${COORDINATOR_URL}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_TOKEN}` },
    body: JSON.stringify(body),
  });
  return parseResponse(route, response);
}

async function get<T extends Json = Json>(route: string, query?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${COORDINATOR_URL}${route}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
  return parseResponse(route, response) as Promise<T>;
}

async function list<T extends Json>(route: string, query?: Record<string, string | number>): Promise<T[]> {
  const body = await get<Json>(route, query);
  const envelope = body as { ok?: boolean; data?: unknown };
  if (Array.isArray(envelope.data)) return envelope.data as T[];
  if (envelope.data && typeof envelope.data === "object" && Array.isArray((envelope.data as Json).items)) {
    return (envelope.data as Json).items as T[];
  }
  return [];
}

async function parseResponse(route: string, response: Response): Promise<Json> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as Json : {};
  if (!response.ok || body.ok === false) {
    throw new Error(`${route} failed: HTTP ${response.status} ${text}`);
  }
  return body;
}

function unwrapData<T>(body: Json): T {
  return body.data as T;
}

function unwrapKey<T>(body: Json, key: string): T {
  const data = unwrapData<Json>(body);
  return data[key] as T;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, label: string, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function waitForHealth(baseUrl: string): Promise<void> {
  await waitForHttp(`${baseUrl}/health`, 60_000);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => undefined);
    return response?.ok ? true : undefined;
  }, url, timeoutMs);
}

function assertEventTypes(events: Json[], required: string[]): void {
  const types = new Set(events.map((event) => String(event.type)));
  const missing = required.filter((type) => !types.has(type));
  if (missing.length > 0) throw new Error(`Missing event types: ${missing.join(", ")}`);
}

function schemaArtifact(): string {
  return [
    "# Goldbach Literature Schema v0.1",
    "- title",
    "- authors",
    "- year",
    "- relevance",
    "- summary",
    "- tags",
  ].join("\n");
}

function literatureIndexArtifact(): string {
  return [
    "# Goldbach Literature Index v0.1",
    "1. Hardy and Littlewood, 1923, relevance=heuristic framework, tags=[circle-method]",
    "2. Vinogradov, 1937, relevance=weak Goldbach methods, tags=[analytic-number-theory]",
    "3. Chen, 1973, relevance=prime plus semiprime theorem, tags=[sieve]",
    "4. Oliveira e Silva et al., 2014, relevance=computational verification, tags=[computation]",
    "5. Helfgott, 2013, relevance=ternary Goldbach proof, tags=[survey, methods]",
  ].join("\n");
}

async function loadYaml<T>(file: string): Promise<T> {
  return YAML.parse(await readScenarioFile(file)) as T;
}

async function readScenarioFile(relative: string): Promise<string> {
  return readFile(path.join(SCENARIO, relative), "utf8");
}

function pipeChild(name: string, child: ChildProcessWithoutNullStreams): void {
  child.stdout.on("data", (chunk) => {
    if (process.env.VIBLY_E2E_VERBOSE === "true") process.stdout.write(`[${name}] ${String(chunk)}`);
  });
  child.stderr.on("data", (chunk) => {
    if (process.env.VIBLY_E2E_VERBOSE === "true") process.stderr.write(`[${name}] ${String(chunk)}`);
  });
}

async function stopChildren(): Promise<void> {
  for (const child of children) child.kill("SIGTERM");
  await sleep(500);
}

function fakeChild(): ChildProcessWithoutNullStreams {
  return { kill: () => true } as ChildProcessWithoutNullStreams;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.once("SIGINT", () => {
  void stopChildren().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void stopChildren().finally(() => process.exit(143));
});

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await stopChildren();
    process.exit(1);
  });
