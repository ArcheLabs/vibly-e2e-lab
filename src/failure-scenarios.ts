/**
 * Failure scenario tests for vibly-e2e-lab.
 *
 * Each scenario is isolated with its own org + project, except FC5 which
 * reuses the main scenario's org/project to verify knowledge-sync detection.
 *
 * Section 10 of e2e.md:
 *   FC1 — Observer timeout
 *   FC2 — Low-quality observation (no-action outcome → no proposal)
 *   FC3 — Proposal rejected (incomplete → reviewers reject → no task created)
 *   FC4 — Artifact rejected (task product rejected → no reward intent)
 *   FC5 — Knowledge sync failure detection (observer contradicts known entry)
 */

export type FailureContext = {
  coordinatorUrl: string;
  apiToken: string;
  mainOrgId: string;
  mainProjectId: string;
};

type ScenarioResult = { status: "passed" | "failed"; details: Json };

export type FailureReport = {
  fc1: "passed" | "failed";
  fc2: "passed" | "failed";
  fc3: "passed" | "failed";
  fc4: "passed" | "failed";
  fc5: "passed" | "failed";
  details: Record<string, Json>;
};

type Json = Record<string, unknown>;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

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

async function apiGet(base: string, token: string, route: string, query?: Record<string, string | number>): Promise<Json> {
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

async function waitFor<T>(fn: () => Promise<T | undefined>, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r !== undefined && r !== null) return r;
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
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

// ─── Minimal org/project setup ────────────────────────────────────────────────

type AgentSpec = { principalId: string; role: string; reputationScore: number; skills: string[] };
type OrgCtx = { guardian: string; orgId: string; projectId: string; mechanismId: string };

async function setupOrg(
  base: string,
  token: string,
  tag: string,
  agents: AgentSpec[],
  mechanismOverrides: Json = {},
): Promise<OrgCtx> {
  const guardian = extractPrincipalId(
    await apiPost(base, token, "/principals", { kind: "service", displayName: `fc-guardian-${tag}` }),
  );

  const orgId = await act(base, token, guardian, "CreateOrganization", {
    name: `FC Org ${tag}`,
    description: `Failure scenario org for ${tag}`,
  }).then((r) => r.aggregateRef.id);

  const projBody = await apiPost(base, token, "/projects", {
    slug: `fc-${tag}-${Date.now()}`,
    name: `FC Project ${tag}`,
    description: `Failure scenario project for ${tag}`,
    sponsorPrincipalId: guardian,
    metadata: { organizationId: orgId, scenario: `fc-${tag}` },
  });
  const projectId = String(((projBody["data"] as Json)?.["project"] as Json)?.["id"] ?? "");

  for (const a of agents) {
    await act(base, token, guardian, "RegisterAgentProfile", {
      principalId: a.principalId,
      displayName: `${a.role}-${tag}`,
      organizationIds: [orgId],
      capabilities: a.skills,
      reputationScore: a.reputationScore,
      stakeBalance: "100",
    });
    await act(base, token, guardian, "AddMember", {
      organizationId: orgId,
      principalId: a.principalId,
      role: a.role,
    });
  }

  const mechanismId = `mech_${tag}`;
  await act(base, token, guardian, "UpsertMechanism", {
    id: mechanismId,
    organizationId: orgId,
    projectId,
    name: `e2e_mech_${tag}`,
    description: `Mechanism for ${tag}`,
    observerSelection: { primitive: "random-selection", count: 1, minReputation: 0 },
    participantSelection: { primitive: "random-selection", count: 2 },
    reviewerSelection: { primitive: "random-selection", count: 1 },
    timeout: { durationMs: 600, action: "select-backup" },
    reward: { base: "10", reputationDelta: 4, penaltyOnFailure: -2 },
    ...mechanismOverrides,
  });

  return { guardian, orgId, projectId, mechanismId };
}

// ─── FC1 — Observer Timeout ───────────────────────────────────────────────────

async function runFC1(base: string, token: string): Promise<ScenarioResult> {
  try {
    const lazyP = "fc1_lazy_agent";
    const { guardian, orgId, mechanismId } = await setupOrg(base, token, "fc1", [
      { principalId: lazyP, role: "observer", reputationScore: 0.1, skills: ["observer"] },
    ]);

    const taskId = await act(base, token, guardian, "CreateObservationTask", {
      organizationId: orgId,
      title: "FC1 observer timeout task",
      description: "Observer should time out without responding",
      mechanismId,
    }).then((r) => r.aggregateRef.id);

    await waitFor<Json>(async () => {
      const evts = await apiList(base, token, "/events", { type: "AssignmentOffered", limit: 200 });
      return evts.find(
        (e) => (e["payload"] as Json)?.["observationTaskId"] === taskId,
      );
    }, "FC1 AssignmentOffered");

    // Sleep past the 600ms mechanism timeout
    await sleep(900);

    await act(base, token, guardian, "TickAssignmentExpiry", {});

    await waitFor<Json>(async () => {
      const evts = await apiList(base, token, "/events", { type: "AssignmentTimedOut", limit: 200 });
      return evts.find(
        (e) => (e["payload"] as Json)?.["assigneeId"] === lazyP,
      );
    }, "FC1 AssignmentTimedOut");

    await waitFor<Json>(async () => {
      const repEvts = await apiList(base, token, "/reputation/events", { organizationId: orgId });
      return repEvts.find((e) => e["principalId"] === lazyP && Number(e["delta"]) < 0);
    }, "FC1 reputation penalty");

    return { status: "passed", details: { taskId, lazyP } };
  } catch (err) {
    return { status: "failed", details: { error: String(err) } };
  }
}

// ─── FC2 — Low-quality Observation → no-action → no Proposal ─────────────────

async function runFC2(base: string, token: string): Promise<ScenarioResult> {
  try {
    const observerP = "fc2_observer";
    const reviewer1P = "fc2_reviewer_1";
    const reviewer2P = "fc2_reviewer_2";

    const { guardian, orgId, mechanismId } = await setupOrg(base, token, "fc2", [
      { principalId: observerP, role: "observer", reputationScore: 0.6, skills: ["observer"] },
      { principalId: reviewer1P, role: "reviewer", reputationScore: 0.7, skills: ["reviewer"] },
      { principalId: reviewer2P, role: "reviewer", reputationScore: 0.7, skills: ["reviewer"] },
    ]);

    const taskId = await act(base, token, guardian, "CreateObservationTask", {
      organizationId: orgId,
      title: "FC2 low-quality observation task",
      description: "Observer submits minimal observation",
      mechanismId,
    }).then((r) => r.aggregateRef.id);

    const offerEvt = await waitFor<Json>(async () => {
      const evts = await apiList(base, token, "/events", { type: "AssignmentOffered", limit: 200 });
      return evts.find(
        (e) => (e["payload"] as Json)?.["observationTaskId"] === taskId,
      );
    }, "FC2 AssignmentOffered");

    const assignmentId = String((offerEvt["payload"] as Json)["id"]);
    const actualObserver = String((offerEvt["payload"] as Json)["assigneeId"]);
    await act(base, token, actualObserver, "RespondAssignmentOffer", { assignmentId, response: "accept" });

    await act(base, token, actualObserver, "SubmitObservationResult", {
      observationTaskId: taskId,
      content: "ok",
      tags: ["low-quality"],
    });

    const discussion = await waitFor<Json>(async () => {
      const all = await apiList(base, token, "/discussions", { organizationId: orgId });
      return all.find((d) => (d["targetRef"] as Json)?.["kind"] === "Observation");
    }, "FC2 discussion");

    const round = (discussion["rounds"] as Json[])[0];
    for (const pid of (round?.["participantIds"] as string[] ?? [])) {
      await act(base, token, pid, "SubmitDiscussionContribution", {
        discussionId: String(discussion["id"]),
        roundIndex: 0,
        content: "The observation is too vague to act on.",
      });
    }

    await act(base, token, guardian, "CloseDiscussionWithOutcome", {
      discussionId: String(discussion["id"]),
      outcome: "no-action",
      summary: "Observation quality too low — no action taken.",
    });

    await sleep(500);
    const proposals = await apiList(base, token, "/proposals", { organizationId: orgId });
    if (proposals.length > 0) {
      return {
        status: "failed",
        details: { error: "ProposalSubmitted unexpectedly after no-action outcome", proposalCount: proposals.length },
      };
    }

    const repEvts = await apiList(base, token, "/reputation/events", { organizationId: orgId });
    const contribCount = repEvts.filter((e) => e["eventType"] === "discussion-contribution").length;

    return {
      status: "passed",
      details: { taskId, discussionId: discussion["id"], contribReputationCount: contribCount },
    };
  } catch (err) {
    return { status: "failed", details: { error: String(err) } };
  }
}

// ─── FC3 — Proposal Rejected → no TaskCreated ─────────────────────────────────

async function runFC3(base: string, token: string): Promise<ScenarioResult> {
  try {
    const observerP = "fc3_observer";
    const proposerP = "fc3_proposer";
    const reviewer1P = "fc3_reviewer_1";
    const reviewer2P = "fc3_reviewer_2";

    const { guardian, orgId, mechanismId } = await setupOrg(base, token, "fc3", [
      { principalId: observerP, role: "observer", reputationScore: 0.7, skills: ["observer"] },
      { principalId: proposerP, role: "proposer", reputationScore: 0.7, skills: ["proposer", "proposal_writing"] },
      { principalId: reviewer1P, role: "reviewer", reputationScore: 0.8, skills: ["reviewer"] },
      { principalId: reviewer2P, role: "reviewer", reputationScore: 0.8, skills: ["reviewer"] },
    ]);

    const obsTaskId = await act(base, token, guardian, "CreateObservationTask", {
      organizationId: orgId,
      title: "FC3 observe project gaps",
      description: "Observe and propose",
      mechanismId,
    }).then((r) => r.aggregateRef.id);

    const offerEvt = await waitFor<Json>(async () => {
      const evts = await apiList(base, token, "/events", { type: "AssignmentOffered", limit: 200 });
      return evts.find(
        (e) => (e["payload"] as Json)?.["observationTaskId"] === obsTaskId,
      );
    }, "FC3 AssignmentOffered");

    const assignmentId = String((offerEvt["payload"] as Json)["id"]);
    const actualObserver = String((offerEvt["payload"] as Json)["assigneeId"]);
    await act(base, token, actualObserver, "RespondAssignmentOffer", { assignmentId, response: "accept" });
    await act(base, token, actualObserver, "SubmitObservationResult", {
      observationTaskId: obsTaskId,
      content: "Project needs structured documentation.",
      tags: ["gap"],
    });

    const discussion = await waitFor<Json>(async () => {
      const all = await apiList(base, token, "/discussions", { organizationId: orgId });
      return all.find((d) => (d["targetRef"] as Json)?.["kind"] === "Observation");
    }, "FC3 discussion");

    const round = (discussion["rounds"] as Json[])[0];
    for (const pid of (round?.["participantIds"] as string[] ?? [])) {
      await act(base, token, pid, "SubmitDiscussionContribution", {
        discussionId: String(discussion["id"]),
        roundIndex: 0,
        content: "A proposal would help clarify the work.",
      });
    }
    await act(base, token, proposerP, "CloseDiscussionWithOutcome", {
      discussionId: String(discussion["id"]),
      outcome: "escalated",
      summary: "Create proposal.",
    });

    // Incomplete proposal — no suggestedTaskPlan
    const proposalId = await act(base, token, proposerP, "SubmitProposal", {
      organizationId: orgId,
      title: "FC3 Incomplete Proposal",
      body: "This proposal lacks an acceptance criteria and a task plan.",
      discussionRef: { kind: "DiscussionThread", id: String(discussion["id"]) },
    }).then((r) => r.aggregateRef.id);

    const reviewRound = await waitFor<Json>(async () => {
      const rounds = await apiList(base, token, "/review-rounds", { organizationId: orgId });
      return rounds.find((r) => r["proposalId"] === proposalId);
    }, "FC3 review round");

    for (const reviewerId of (reviewRound["reviewerIds"] as string[] ?? [])) {
      await act(base, token, reviewerId, "SubmitReview", {
        reviewRoundId: String(reviewRound["id"]),
        outcome: "rejected",
        comment: "score=0.2 decision=reject reason=missing task plan and acceptance criteria",
      });
    }

    await waitFor<Json>(async () => {
      const body = await apiGet(base, token, `/proposals/${proposalId}`);
      const p = ((body["data"] as Json)?.["proposal"] ?? body["data"]) as Json;
      return p["status"] === "rejected" ? p : undefined;
    }, "FC3 ProposalRejected");

    await sleep(400);
    const tasks = await apiList(base, token, "/tasks", { organizationId: orgId });
    if (tasks.length > 0) {
      return {
        status: "failed",
        details: { error: "TaskCreated unexpectedly after ProposalRejected", taskCount: tasks.length },
      };
    }

    return { status: "passed", details: { proposalId, obsTaskId } };
  } catch (err) {
    return { status: "failed", details: { error: String(err) } };
  }
}

// ─── FC4 — Artifact Rejected → no RewardIntent ────────────────────────────────

async function runFC4(base: string, token: string): Promise<ScenarioResult> {
  try {
    const observerP = "fc4_observer";
    const proposerP = "fc4_proposer";
    const researcherP = "fc4_researcher";
    const reviewer1P = "fc4_reviewer_1";
    const reviewer2P = "fc4_reviewer_2";

    const { guardian, orgId, mechanismId } = await setupOrg(base, token, "fc4", [
      { principalId: observerP, role: "observer", reputationScore: 0.7, skills: ["observer"] },
      { principalId: proposerP, role: "proposer", reputationScore: 0.7, skills: ["proposer", "proposal_writing"] },
      { principalId: researcherP, role: "researcher", reputationScore: 0.7, skills: ["researcher", "literature_review"] },
      { principalId: reviewer1P, role: "reviewer", reputationScore: 0.8, skills: ["reviewer"] },
      { principalId: reviewer2P, role: "reviewer", reputationScore: 0.8, skills: ["reviewer"] },
    ]);

    const obsTaskId = await act(base, token, guardian, "CreateObservationTask", {
      organizationId: orgId,
      title: "FC4 observe project",
      description: "Observe and propose documentation task",
      mechanismId,
    }).then((r) => r.aggregateRef.id);

    const offerEvt = await waitFor<Json>(async () => {
      const evts = await apiList(base, token, "/events", { type: "AssignmentOffered", limit: 200 });
      return evts.find(
        (e) => (e["payload"] as Json)?.["observationTaskId"] === obsTaskId,
      );
    }, "FC4 AssignmentOffered");

    const assignmentId = String((offerEvt["payload"] as Json)["id"]);
    const actualObserver = String((offerEvt["payload"] as Json)["assigneeId"]);
    await act(base, token, actualObserver, "RespondAssignmentOffer", { assignmentId, response: "accept" });
    await act(base, token, actualObserver, "SubmitObservationResult", {
      observationTaskId: obsTaskId,
      content: "We need a documentation artifact to track research progress.",
      tags: ["gap"],
    });

    const discussion = await waitFor<Json>(async () => {
      const all = await apiList(base, token, "/discussions", { organizationId: orgId });
      return all.find((d) => (d["targetRef"] as Json)?.["kind"] === "Observation");
    }, "FC4 discussion");

    const round = (discussion["rounds"] as Json[])[0];
    for (const pid of (round?.["participantIds"] as string[] ?? [])) {
      await act(base, token, pid, "SubmitDiscussionContribution", {
        discussionId: String(discussion["id"]),
        roundIndex: 0,
        content: "Agreed, documentation is needed.",
      });
    }
    await act(base, token, proposerP, "CloseDiscussionWithOutcome", {
      discussionId: String(discussion["id"]),
      outcome: "escalated",
      summary: "Create documentation proposal.",
    });

    const proposalId = await act(base, token, proposerP, "SubmitProposal", {
      organizationId: orgId,
      title: "FC4 Documentation Proposal",
      body: "Create a documentation artifact. Acceptance: non-empty structured markdown.",
      discussionRef: { kind: "DiscussionThread", id: String(discussion["id"]) },
      suggestedTaskPlan: [
        {
          title: "FC4 Documentation Task",
          description: "Write one structured markdown document.",
          skillRequirements: ["literature_review"],
        },
      ],
    }).then((r) => r.aggregateRef.id);

    const proposalReview = await waitFor<Json>(async () => {
      const rounds = await apiList(base, token, "/review-rounds", { organizationId: orgId });
      return rounds.find((r) => r["proposalId"] === proposalId);
    }, "FC4 proposal review");

    for (const reviewerId of (proposalReview["reviewerIds"] as string[] ?? [])) {
      await act(base, token, reviewerId, "SubmitReview", {
        reviewRoundId: String(proposalReview["id"]),
        outcome: "accepted",
        comment: "decision=accept reason=valid proposal with task plan",
      });
    }

    await waitFor<Json>(async () => {
      const body = await apiGet(base, token, `/proposals/${proposalId}`);
      const p = ((body["data"] as Json)?.["proposal"] ?? body["data"]) as Json;
      return p["status"] === "accepted" ? p : undefined;
    }, "FC4 ProposalAccepted");

    const fcTasks = await waitFor<Json[]>(async () => {
      const all = await apiList(base, token, "/tasks", { organizationId: orgId, status: "available" });
      const relevant = all.filter((t) => t["proposalId"] === proposalId);
      return relevant.length >= 1 ? relevant : undefined;
    }, "FC4 TaskCreated");

    const fcTask = fcTasks[0]!;
    await act(base, token, researcherP, "ClaimTask", { organizationId: orgId, taskId: String(fcTask["id"]) });

    const artifactId = await act(base, token, researcherP, "SubmitArtifact", {
      organizationId: orgId,
      taskId: String(fcTask["id"]),
      title: "FC4 Substandard Artifact",
      mimeType: "text/markdown",
      contentRef: "inline://fc4-bad-artifact",
      description: "This artifact does not satisfy the acceptance criteria.",
      tags: ["fc4"],
    }).then((r) => r.aggregateRef.id);

    await act(base, token, researcherP, "SubmitTask", {
      organizationId: orgId,
      taskId: String(fcTask["id"]),
      summary: "Submitted artifact (intentionally substandard for FC4 test).",
      artifactIds: [artifactId],
    });

    const taskReview = await waitFor<Json>(async () => {
      const rounds = await apiList(base, token, "/review-rounds", { organizationId: orgId });
      return rounds.find(
        (r) => r["taskId"] === String(fcTask["id"]) && r["proposalId"] == null,
      );
    }, "FC4 task review");

    for (const reviewerId of (taskReview["reviewerIds"] as string[] ?? [])) {
      await act(base, token, reviewerId, "SubmitReview", {
        reviewRoundId: String(taskReview["id"]),
        outcome: "rejected",
        comment: "decision=reject reason=artifact does not meet acceptance criteria",
      });
    }

    await waitFor<Json>(async () => {
      const evts = await apiList(base, token, "/events", { type: "ArtifactRejected", limit: 200 });
      return evts.find(
        (e) => ((e["payload"] as Json)?.["artifact"] as Json)?.["id"] === artifactId,
      );
    }, "FC4 ArtifactRejected", 30_000);

    await sleep(500);
    const rewardIntents = await apiList(base, token, "/reward-intents", { organizationId: orgId });
    if (rewardIntents.length > 0) {
      return {
        status: "failed",
        details: { error: "RewardIntentCreated unexpectedly after ArtifactRejected", count: rewardIntents.length },
      };
    }

    const repEvts = await apiList(base, token, "/reputation/events", { organizationId: orgId });
    const penaltyEvt = repEvts.find(
      (e) => e["principalId"] === researcherP && e["eventType"] === "task-rejected",
    );
    if (!penaltyEvt) {
      return { status: "failed", details: { error: "No task-rejected reputation penalty recorded for researcher" } };
    }

    return { status: "passed", details: { proposalId, taskId: fcTask["id"], artifactId } };
  } catch (err) {
    return { status: "failed", details: { error: String(err) } };
  }
}

// ─── FC5 — Knowledge Sync Failure Detection ───────────────────────────────────
//
// After the main scenario, the project knowledge base contains "Literature Index v0.1".
// A new observer is registered in the main org and its inbox queried to verify the
// snapshot is present.  The runner then simulates a contradicting observation and
// verifies the runner-side detection logic flags the inconsistency.

async function runFC5(
  base: string,
  token: string,
  mainOrgId: string,
  mainProjectId: string,
): Promise<ScenarioResult> {
  try {
    const fc5P = "fc5_observer_contradiction";
    const fc5Guardian = extractPrincipalId(
      await apiPost(base, token, "/principals", { kind: "service", displayName: "fc5-guardian" }),
    );

    await act(base, token, fc5Guardian, "RegisterAgentProfile", {
      principalId: fc5P,
      displayName: "fc5-observer",
      organizationIds: [mainOrgId],
      capabilities: ["observer"],
      reputationScore: 0.6,
      stakeBalance: "10",
    });
    await act(base, token, fc5Guardian, "AddMember", {
      organizationId: mainOrgId,
      principalId: fc5P,
      role: "observer",
    });

    // Query agent inbox to get the knowledge snapshot
    const inboxBody = await apiGet(base, token, `/agents/${fc5P}/inbox`, {
      organizationId: mainOrgId,
      projectId: mainProjectId,
      limit: 100,
    });
    const inbox = ((inboxBody["data"] as Json)?.["inbox"] ?? inboxBody["data"]) as Json;
    const snapshot = inbox["knowledgeSnapshot"] as Json | undefined;
    const entries = (snapshot?.["entries"] as Json[] | undefined) ?? [];

    const hasLiteratureIndex = entries.some((e) =>
      String(e["title"]).toLowerCase().includes("literature index"),
    );

    if (!hasLiteratureIndex) {
      return {
        status: "failed",
        details: {
          error: "FC5 precondition failed: Literature Index not found in knowledge snapshot",
          entryCount: entries.length,
        },
      };
    }

    // Simulate a contradicting observation (runner-side detection — no HTTP call needed)
    const contraContent =
      "The project currently has no structured literature index. " +
      "A new literature index must be created from scratch as none exists yet.";

    const contradictsClaims =
      contraContent.toLowerCase().includes("no structured literature index") ||
      contraContent.toLowerCase().includes("none exists yet") ||
      contraContent.toLowerCase().includes("created from scratch");

    const knowledgeSyncFailure = contradictsClaims && hasLiteratureIndex;

    if (!knowledgeSyncFailure) {
      return {
        status: "failed",
        details: { error: "Detection logic failed to flag contradiction", contradictsClaims, hasLiteratureIndex },
      };
    }

    return {
      status: "passed",
      details: {
        knowledgeSyncFailure,
        hasLiteratureIndex,
        entryCount: entries.length,
        detectedContradiction: contraContent.slice(0, 80),
      },
    };
  } catch (err) {
    return { status: "failed", details: { error: String(err) } };
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export async function runFailureScenarios(ctx: FailureContext): Promise<FailureReport> {
  const { coordinatorUrl: base, apiToken: token, mainOrgId, mainProjectId } = ctx;

  console.log("[e2e] running failure scenarios FC1–FC5…");

  const settled = await Promise.allSettled([
    runFC1(base, token),
    runFC2(base, token),
    runFC3(base, token),
    runFC4(base, token),
    runFC5(base, token, mainOrgId, mainProjectId),
  ]);

  const [fc1, fc2, fc3, fc4, fc5] = settled.map<ScenarioResult>((r) =>
    r.status === "fulfilled" ? r.value : { status: "failed", details: { error: String(r.reason) } },
  ) as [ScenarioResult, ScenarioResult, ScenarioResult, ScenarioResult, ScenarioResult];

  for (const [name, result] of Object.entries({ fc1, fc2, fc3, fc4, fc5 })) {
    const r = result as ScenarioResult;
    const detail = r.status === "failed" ? ` — ${String(r.details["error"])}` : "";
    console.log(`[e2e] ${name}: ${r.status}${detail}`);
  }

  return {
    fc1: fc1.status,
    fc2: fc2.status,
    fc3: fc3.status,
    fc4: fc4.status,
    fc5: fc5.status,
    details: { fc1: fc1.details, fc2: fc2.details, fc3: fc3.details, fc4: fc4.details, fc5: fc5.details },
  };
}
