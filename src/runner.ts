import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { runFailureScenarios } from "./failure-scenarios.js";
import { runSemiAutonomousScenario } from "./semi-autonomous.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { networkInterfaces } from "node:os";
import YAML from "yaml";
import {
  startSoloNode,
  stopSoloNode,
  type SoloNodeHandle,
} from "./lifecycle/soloNode.js";
import { resolveUseRealStake } from "./lifecycle/stakeMode.js";
import {
  startIndexer,
  stopIndexer,
  type IndexerHandle,
} from "./lifecycle/indexer.js";
import { assertPortAvailable } from "./lifecycle/ports.js";
import {
  localNetworkProfile,
  publicConsoleNetworkProfiles,
  serverCoordinatorNetworkProfiles,
  type E2eNetworkProfile,
} from "./lifecycle/networkProfiles.js";
import {
  consoleStartTimeoutMs,
  resetConsoleDevCache,
  waitForHttpWithChild,
  withConsoleDevEnv,
} from "./lifecycle/consoleDev.js";
import { seedChainAgent, waitForCoordinatorStakeSync, type ChainSeedReceipt } from "./chainSeed.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCENARIO = path.join(ROOT, "scenarios", "vibing-math");
const REPORT_DIR = path.join(ROOT, "reports");
const DATA_DIR = path.join(ROOT, "data");
const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const CONSOLE_PORT = Number(process.env.VIBLY_E2E_CONSOLE_PORT ?? "3001");
const PAYMENT_CHAIN_RPC_PORT = Number(process.env.VIBLY_E2E_PAYMENT_CHAIN_RPC_PORT ?? "9945");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? `http://127.0.0.1:${COORDINATOR_PORT}`;
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";
const CHAIN_ID = process.env.VIBLY_E2E_CHAIN_ID ?? "substrate:vibly-solo";
const KEEP_ALIVE =
  process.env.VIBLY_E2E_KEEP_ALIVE === "true" ||
  process.env.VIBLY_E2E_KEEP_ALIVE_ON_SUCCESS === "true" ||
  process.env.VIBLY_E2E_KEEP_ALIVE_ON_FAILURE === "true";
const KEEP_ALIVE_ON_SUCCESS = KEEP_ALIVE || process.env.VIBLY_E2E_KEEP_ALIVE_ON_SUCCESS === "true";
const KEEP_ALIVE_ON_FAILURE = KEEP_ALIVE || process.env.VIBLY_E2E_KEEP_ALIVE_ON_FAILURE === "true";

/**
 * When VIBLY_E2E_MOCK_STAKE=true the runner uses the legacy
 * UpsertAgentStakeLedger coordinator seed and does NOT start chain/indexer.
 * By default it prefers the real chain-backed flow, but falls back to mock
 * stake when no local solo-node binary is available.
 */
const USE_REAL_STAKE = resolveUseRealStake("e2e:local");

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
let soloNodeHandle: SoloNodeHandle | undefined;
let paymentNodeHandle: SoloNodeHandle | undefined;
let indexerHandle: IndexerHandle | undefined;
let localProfile: E2eNetworkProfile | undefined;

async function main(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  // ── Chain / payment-chain / indexer lifecycle ─────────────────────────────
  soloNodeHandle = await startSoloNode({ rpcExternal: true, serviceName: "Vibly chain" });
  paymentNodeHandle = await startSoloNode({
    rpcPort: PAYMENT_CHAIN_RPC_PORT,
    rpcExternal: true,
    serviceName: "payment chain",
  });
  localProfile = localNetworkProfile({
    coordinatorUrl: COORDINATOR_URL,
    viblyRpcUrl: soloNodeHandle.wsUrl,
    paymentRpcUrl: paymentNodeHandle.wsUrl,
  });

  if (USE_REAL_STAKE) {
    indexerHandle = await startIndexer(soloNodeHandle.rpcPort);
  }

  const coordinator = await startCoordinator();
  let consoleProcess: ChildProcessWithoutNullStreams | undefined;
  if (process.env.VIBLY_E2E_SKIP_CONSOLE !== "true") {
    consoleProcess = await startConsole();
  }

  let completed = false;
  let reportPath: string | undefined;
  let stakeReportPath: string | undefined;
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
    reportPath = path.join(REPORT_DIR, `deterministic-${ts}.json`);
    console.log(`[e2e] deterministic scenario passed. report=${reportPath}`);
    const failedFCs = (["fc1", "fc2", "fc3", "fc4", "fc5"] as const).filter((k) => failureReport[k] !== "passed");
    if (failedFCs.length > 0) {
      console.warn(`[e2e] failure scenarios not all passed: ${failedFCs.join(", ")}`);
    } else {
      console.log("[e2e] all failure scenarios passed.");
    }

    // ── Phase D: semi-autonomous LLM mode (opt-in) ──────────────────────────────
    const llmApiKey = process.env.OPENAI_API_KEY;
    let semiAutonomous: Record<string, unknown> | undefined;
    if (llmApiKey) {
      const llmBaseURL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
      const llmModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
      console.log(`[e2e] semi-autonomous mode enabled (baseURL=${llmBaseURL}, model=${llmModel})`);
      semiAutonomous = await runSemiAutonomousScenario(COORDINATOR_URL, API_TOKEN, {
        apiKey: llmApiKey,
        baseURL: llmBaseURL,
        model: llmModel,
      });
      console.log(`[e2e] semi-autonomous: ${String(semiAutonomous["status"])}`);
    } else {
      console.log("[e2e] OPENAI_API_KEY not set — semi-autonomous mode skipped.");
      semiAutonomous = { status: "skipped" };
    }

    await writeFile(
      reportPath,
      JSON.stringify({ ...trace, failureScenarios: failureReport, semiAutonomous }, null, 2),
    );

    if (USE_REAL_STAKE) {
      stakeReportPath = path.join(REPORT_DIR, `chain-stake-${ts}.json`);
      await writeFile(
        stakeReportPath,
        JSON.stringify(
          {
            stakeMode: trace.mode,
            sseTiming: trace.sseTiming,
            chainSeed: trace.chainSeed,
          },
          null,
          2,
        ),
      );
      console.log(`[e2e] chain-stake report=${stakeReportPath}`);
    }
    completed = true;
  } finally {
    if ((completed && KEEP_ALIVE_ON_SUCCESS) || (!completed && KEEP_ALIVE_ON_FAILURE)) {
      printKeepAliveInfo({ completed, reportPath, stakeReportPath, consoleAvailable: Boolean(consoleProcess) });
      await waitUntilInterrupted();
    }
    await stopChildren();
    coordinator.kill("SIGTERM");
    consoleProcess?.kill("SIGTERM");
    if (indexerHandle) await stopIndexer();
    if (paymentNodeHandle) await stopSoloNode(paymentNodeHandle);
    if (soloNodeHandle) await stopSoloNode(soloNodeHandle);
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

  const guardianPrincipal = await post("/principals", { kind: "agent", displayName: "human-guardian" })
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

  // Chain seed receipts — populated in real-stake mode, empty in mock mode.
  const chainSeedReceipts: Record<string, ChainSeedReceipt> = {};

  for (const agent of agents.agents) {
    const capabilities = [...new Set([...agent.roleHints, ...Object.keys(agent.skills)])];
    const reputationScore = agent.id === "lazy-agent" ? 0.1 : 0.7;

    // ── Real stake mode: seed identity/agent/bond on chain ─────────────────
    let identityId: string;
    let chainAgentId: string;

    if (USE_REAL_STAKE) {
      const receipt = await seedChainAgent({
        agentId: agent.id,
        coordinatorUrl: COORDINATOR_URL,
        apiToken: API_TOKEN,
        chainRpcUrl: `ws://127.0.0.1:${soloNodeHandle?.rpcPort ?? 9944}`,
        graphqlUrl: indexerHandle?.graphqlUrl ?? "http://127.0.0.1:3010/graphql",
        chainId: CHAIN_ID,
        bondAmount: "100",
      });
      identityId = receipt.identityId;
      chainAgentId = receipt.chainAgentId;
      chainSeedReceipts[agent.id] = receipt;
    } else {
      // ── Mock stake fallback (legacy) ──────────────────────────────────────
      identityId = `identity_${agent.id}`;
      chainAgentId = `chain_agent_${agent.id}`;
      await action("UpsertAgentStakeLedger", guardian, {
        chainId: CHAIN_ID,
        identityId,
        chainAgentId,
        principalId: agent.principalId,
        fundingAccount: `${agent.id}_funding`,
        activeAmount: "100",
        unbondingAmount: "0",
        status: "active",
        releaseBlocked: false,
        updatedAtBlock: "1",
      });
    }

    await action("RegisterAgentProfile", guardian, {
      principalId: agent.principalId,
      displayName: agent.id,
      organizationIds: [orgId],
      capabilities,
      reputationScore,
      chainId: CHAIN_ID,
      identityId,
      chainAgentId,
      dutyStatus: "active",
    });
    if (USE_REAL_STAKE) {
      await waitForCoordinatorStakeSync(COORDINATOR_URL, API_TOKEN, agent.principalId, 60_000, CHAIN_ID);
    }
    await action("AddMember", guardian, {
      organizationId: orgId,
      principalId: agent.principalId,
      role: agent.roleHints[0] ?? "agent",
    });
  }

  await action("RequestAgentDutyPause", "principal_lazy", {
    principalId: "principal_lazy",
    reason: "E2E verifies idle agents can pause public duties",
  });
  await waitFor<Json>(() => get<Json>("/agent-profiles/principal_lazy").then((body) => unwrapKey<Json>(body, "agent"))
    .then((agent) => agent.dutyStatus === "paused" ? agent : undefined), "paused lazy agent");
  await action("ResumeAgentDuty", "principal_lazy", { principalId: "principal_lazy" });

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

  const daemonProcesses = await startAgentDaemons(agents.agents, projectId);

  const proposalRequestSeen = await waitFor<Json>(() => getInbox("principal_proposer", orgId, projectId)
    .then((inbox) => (inbox.notifications as Json[]).find((item) => item.type === "ProposalCreationRequest")), "proposal request", 20_000)
    .then(() => true)
    .catch(() => false);

  const proposal = await waitFor<Json>(() => list<Json>("/proposals", { organizationId: orgId })
    .then((items) => items.find((item) => String(item.title ?? "").includes("Literature Index"))), "daemon-submitted proposal", 60_000);
  const proposalId = String(proposal.id);

  await waitFor<Json>(() => get<Json>(`/proposals/${proposalId}`).then((body) => unwrapKey<Json>(body, "proposal"))
    .then((item) => item.status === "accepted" ? item : undefined), "accepted proposal", 120_000);

  const tasks = await waitFor<Json[]>(() => list<Json>("/tasks", { organizationId: orgId })
    .then((items) => items.filter((item) => item.proposalId === proposalId).length >= 2 ? items.filter((item) => item.proposalId === proposalId) : undefined), "proposal tasks");

  const artifactIds = await waitFor<string[]>(() => list<Json>("/artifacts", { organizationId: orgId })
    .then((items) => {
      const accepted = items.filter((item) => tasks.some((task) => task.id === item.taskId));
      return accepted.length >= tasks.length ? accepted.map((item) => String(item.id)) : undefined;
    }), "daemon-submitted artifacts", 180_000);

  await waitFor<Json[]>(() => list<Json>("/artifacts", { organizationId: orgId })
    .then((items) => artifactIds.every((id) => items.some((item) => item.id === id && item.status === "merged")) ? items : undefined), "merged artifacts", 180_000);
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
  await waitFor<Json[]>(() => list<Json>("/observations", { organizationId: orgId })
    .then((items) => items.some((item) => item.observationTaskId === secondTaskId && String(item.content ?? "").includes("already exists"))
      ? items
      : undefined), "second daemon observation", 45_000);

  // ── Phase 7: SSE timing assertion ─────────────────────────────────────────
  // Create a third observation task; daemons use a short interval (750 ms),
  // so if the SSE push is working the daemon should respond well within 5 s.
  let sseTiming: Json = { status: "skipped" };
  if (process.env.VIBLY_E2E_SKIP_SSE_TIMING !== "true") {
    const sseTaskId = await action("CreateObservationTask", guardian, {
      organizationId: orgId,
      projectId,
      title: "SSE timing probe",
      description: "Verify daemon responds promptly via SSE push.",
      mechanismId: "mechanism_vibing_math_main",
    }).then((result) => result.aggregateRef.id);

    const taskCreatedAt = Date.now();
    try {
      await waitFor<Json>(
        () =>
          list<Json>("/events", { limit: 50, organizationId: orgId }).then((evts) =>
            evts.find(
              (e) =>
                (e.type === "AssignmentAccepted" || e.type === "ObservationSubmitted") &&
                String(e.observationTaskId ?? e.taskId ?? "") === sseTaskId,
            ),
          ),
        "SSE timing probe — daemon accepted assignment",
        10_000,
      );
      const elapsed = Date.now() - taskCreatedAt;
      const sseDelivered = elapsed < 5_000;
      sseTiming = { status: sseDelivered ? "passed" : "slow", elapsedMs: elapsed };
      if (sseDelivered) {
        console.log(`[e2e] SSE timing: daemon responded in ${elapsed}ms ✓`);
      } else {
        console.warn(`[e2e] SSE timing: daemon took ${elapsed}ms (>5s — possible polling fallback)`);
      }
    } catch {
      sseTiming = { status: "no-response", elapsedMs: Date.now() - taskCreatedAt };
    }
  }

  const requiredEventTypes = [
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
  ];
  const events = (await Promise.all(
    requiredEventTypes.map((type) => list<Json>("/events", { type, limit: 200 })),
  )).flat();
  assertEventTypes(events, requiredEventTypes);

  return {
    mode: USE_REAL_STAKE ? "real-stake" : "mock-stake",
    organizationId: orgId,
    projectId,
    proposalId,
    taskIds: tasks.map((task) => task.id),
    artifactIds,
    proposalRequestSeen,
    daemonPids: daemonProcesses.map((child) => child.pid),
    eventTypes: events.map((event) => event.type),
    sseTiming,
    chainSeed: USE_REAL_STAKE
      ? Object.fromEntries(
          Object.entries(chainSeedReceipts).map(([id, r]) => [
            id,
            {
              identityId: r.identityId,
              chainAgentId: r.chainAgentId,
              bondTxHash: r.bondTxHash,
              indexerLedgerStatus: r.indexerLedger.status,
            },
          ]),
        )
      : "mock",
  };
}

async function startCoordinator(): Promise<ChildProcessWithoutNullStreams> {
  if (process.env.VIBLY_E2E_EXTERNAL_COORDINATOR === "true") {
    await waitForHealth(COORDINATOR_URL);
    return fakeChild();
  }
  await assertPortAvailable({
    port: COORDINATOR_PORT,
    serviceName: "Local coordinator",
    portEnv: "VIBLY_E2E_COORDINATOR_PORT",
    externalModeEnv: "VIBLY_E2E_EXTERNAL_COORDINATOR",
  });
  const dbPath = path.join(DATA_DIR, "vibly-e2e-coordinator.sqlite");
  // Remove SQLite main file and WAL journal files to ensure a clean state
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rm(`${dbPath}-wal`, { force: true });

  // In real-stake mode, wire the coordinator to the running indexer.
  const stakeEnv: Record<string, string> = USE_REAL_STAKE
    ? {
        SUBSTRATE_INDEXER_URL: indexerHandle?.graphqlUrl ?? "http://127.0.0.1:3010/graphql",
        AGENT_STAKE_SYNC_INTERVAL_MS: "500",
        SUBSTRATE_STAKE_TX_MODE: "fixture",
        SUBSTRATE_CHAIN_ID: CHAIN_ID,
      }
    : {};

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
      GOVERNANCE_BACKENDS: "none",
      ASSIGNMENT_EXPIRY_INTERVAL_MS: process.env.ASSIGNMENT_EXPIRY_INTERVAL_MS ?? "250",
      VIBLY_DOT_RECEIVING_ADDRESS: process.env.VIBLY_DOT_RECEIVING_ADDRESS ?? "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      GET_VIB_RELAY_RPC_URL: process.env.GET_VIB_RELAY_RPC_URL ?? requireLocalProfile().paymentRpcUrls[0] ?? "",
      GET_VIB_RELAY_CHAIN_ID: process.env.GET_VIB_RELAY_CHAIN_ID ?? "polkadot-local",
      GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: process.env.GET_VIB_DEPOSIT_SCAN_INTERVAL_MS ?? "1500",
      ...stakeEnv,
    },
    stdio: "pipe",
  });
  pipeChild("coordinator", child);
  children.push(child);
  await waitForHealth(COORDINATOR_URL);
  return child;
}

async function startConsole(): Promise<ChildProcessWithoutNullStreams> {
  const consoleOrigin = `http://localhost:${CONSOLE_PORT}`;
  await resetConsoleDevCache(ROOT);
  const child = spawn("pnpm", ["--dir", path.resolve(ROOT, "../vibly-console"), "exec", "next", "dev", "--webpack", "-p", String(CONSOLE_PORT)], {
    env: withConsoleDevEnv({
      ...process.env,
      COORDINATOR_URL,
      NEXT_PUBLIC_COORDINATOR_URL: COORDINATOR_URL,
      COORDINATOR_API_TOKEN: API_TOKEN,
      AUTH_URL: consoleOrigin,
      NEXTAUTH_URL: consoleOrigin,
      AUTH_SECRET: "vibly-e2e-local-secret",
      AUTH_DEV_CREDENTIALS: "true",
      NEXT_PUBLIC_VIBLY_NETWORK_ID: requireLocalProfile().id,
      NEXT_PUBLIC_VIBLY_NETWORK_NAME: requireLocalProfile().label,
      NEXT_PUBLIC_VIBLY_RPC_URL: requireLocalProfile().viblyRpcUrls[0] ?? "",
      NEXT_PUBLIC_PAYMENT_RPC_URL: requireLocalProfile().paymentRpcUrls[0] ?? "",
      NEXT_PUBLIC_POLKADOT_RPC_URL: requireLocalProfile().paymentRpcUrls[0] ?? "",
      NEXT_PUBLIC_VIBLY_NETWORK_PROFILES: publicConsoleNetworkProfiles(requireLocalProfile()),
      VIBLY_COORDINATOR_NETWORK_PROFILES: serverCoordinatorNetworkProfiles(requireLocalProfile()),
      PORT: String(CONSOLE_PORT),
    }),
    stdio: "pipe",
  });
  pipeChild("console", child);
  children.push(child);
  await waitForHttpWithChild(`${consoleOrigin}/personal-center`, consoleStartTimeoutMs(), child);
  return child;
}

function requireLocalProfile(): E2eNetworkProfile {
  if (!localProfile) throw new Error("Local E2E network profile was not initialized.");
  return localProfile;
}

async function startAgentDaemons(agents: AgentConfig[], projectId: string): Promise<ChildProcessWithoutNullStreams[]> {
  const started: Array<{ agentId: string; child: ChildProcessWithoutNullStreams }> = [];
  for (const agent of agents) {
    const home = path.join(DATA_DIR, "clients", agent.id);
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "config.json"), JSON.stringify({
      version: "0.1.0",
      defaultProfile: "default",
      profiles: {
        default: {
          name: "default",
          coordinatorUrl: COORDINATOR_URL,
          principalId: agent.principalId,
          agentId: agent.id,
          projectId,
          apiTokenRef: "env:VIBLY_API_TOKEN",
          daemon: {
            deterministicE2E: true,
            autoReview: true,
            autoClaimRewards: true,
          },
        },
      },
    }, null, 2));

    const child = spawn("pnpm", ["--dir", path.resolve(ROOT, "../vibly-client"), "dev", "--", "daemon", "start", "--interval", "750"], {
      env: {
        ...process.env,
        VIBLY_HOME: home,
        VIBLY_API_TOKEN: API_TOKEN,
        LOG_LEVEL: "warn",
      },
      stdio: "pipe",
    });
    pipeChild(`agent:${agent.id}`, child);
    children.push(child);
    started.push({ agentId: agent.id, child });
  }
  await sleep(1000);
  const failed = started
    .filter(({ child }) => child.exitCode !== null)
    .map(({ agentId, child }) => `${agentId} (exit=${String(child.exitCode)})`);
  if (failed.length > 0) {
    throw new Error(
      [
        `Agent daemons exited before the deterministic scenario could begin: ${failed.join(", ")}.`,
        "Install vibly-client dependencies first: cd ../vibly-client && pnpm install",
      ].join(" "),
    );
  }
  return started.map(({ child }) => child);
}

async function smokeConsole(projectId: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${CONSOLE_PORT}/`);
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
  if (missing.length > 0) {
    throw new Error(
      `Missing event types: ${missing.join(", ")}. Fetched ${events.length} events; saw: ${[...types].slice(0, 80).join(", ")}`,
    );
  }
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

function printKeepAliveInfo(input: {
  completed: boolean;
  reportPath?: string;
  stakeReportPath?: string;
  consoleAvailable: boolean;
}): void {
  console.log("");
  console.log(`[e2e] Keep-alive mode enabled after ${input.completed ? "success" : "failure"}.`);
  console.log("[e2e] Processes and data are being left running for inspection.");
  console.log(`[e2e] Coordinator: ${COORDINATOR_URL}`);
  if (input.consoleAvailable) {
    console.log(`[e2e] Console: http://localhost:${CONSOLE_PORT}`);
    console.log(`[e2e] Console (127.0.0.1): http://127.0.0.1:${CONSOLE_PORT}`);
    const networkAddress = getFirstNetworkAddress();
    if (networkAddress) console.log(`[e2e] Console (WSL/LAN): http://${networkAddress}:${CONSOLE_PORT}`);
    console.log("[e2e] Use one Console host consistently after sign-in; localhost is preferred for browser session cookies and HMR.");
  } else {
    console.log("[e2e] Console: not started");
  }
  if (indexerHandle) console.log(`[e2e] Indexer GraphQL: ${indexerHandle.graphqlUrl}`);
  if (soloNodeHandle) console.log(`[e2e] Chain RPC: ${soloNodeHandle.wsUrl}`);
  if (input.reportPath) console.log(`[e2e] Deterministic report: ${input.reportPath}`);
  if (input.stakeReportPath) console.log(`[e2e] Chain stake report: ${input.stakeReportPath}`);
  console.log("[e2e] Press Ctrl+C to stop child processes. Docker volumes and SQLite data are kept.");
  console.log("[e2e] To clean indexer state later: cd ../vibly-indexer && docker compose down -v --remove-orphans");
}

async function waitUntilInterrupted(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

function getFirstNetworkAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.once("SIGINT", () => {
  void cleanupForSignal().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void cleanupForSignal().finally(() => process.exit(143));
});

async function cleanupForSignal(): Promise<void> {
  await stopChildren();
  if (indexerHandle && !KEEP_ALIVE) await stopIndexer();
  if (soloNodeHandle) await stopSoloNode(soloNodeHandle);
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await stopChildren();
    process.exit(1);
  });
