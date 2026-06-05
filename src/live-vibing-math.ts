import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import path from "node:path";
import process from "node:process";
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
import {
  createInitialLiveRunState,
  isPauseBoundary,
  liveRunDir,
  loadLiveRunState,
  markMilestone,
  saveLiveRunState,
  sanitizeRunName,
  shouldPauseAt,
  type LiveRunState,
  type PauseBoundary,
} from "./liveState.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCENARIO = path.join(ROOT, "scenarios", "vibing-math");
const REPORT_DIR = path.join(ROOT, "reports");
const DATA_DIR = path.join(ROOT, "data");
const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const CONSOLE_PORT = Number(process.env.VIBLY_E2E_CONSOLE_PORT ?? "3001");
const PAYMENT_CHAIN_RPC_PORT = Number(process.env.VIBLY_E2E_PAYMENT_CHAIN_RPC_PORT ?? "9945");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? `http://127.0.0.1:${COORDINATOR_PORT}`;
const COORDINATOR_START_TIMEOUT_MS = Number(process.env.VIBLY_E2E_COORDINATOR_START_TIMEOUT_MS ?? "120000");
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";
const CHAIN_ID = process.env.VIBLY_E2E_CHAIN_ID ?? "substrate:vibly-solo";
const USE_REAL_STAKE = resolveUseRealStake("e2e:live-llm");
const ENABLE_GET_VIB_LOCAL = process.env.VIBLY_E2E_ENABLE_GET_VIB_LOCAL === "true";
const DEFAULT_GET_VIB_DEPOSIT_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const EXTERNAL_COORDINATOR = process.env.VIBLY_E2E_EXTERNAL_COORDINATOR === "true";
const TESTNET_SEED = process.env.VIBLY_E2E_TESTNET_SEED === "true";
const RESUME_RUN = process.env.VIBLY_E2E_RESUME === "true";
const RESET_RUN = process.env.VIBLY_E2E_RESET_RUN === "true";
const HAS_EXPLICIT_RUN_NAME = Boolean(process.env.VIBLY_E2E_RUN_NAME);
const KEEP_ALIVE =
  process.env.VIBLY_E2E_KEEP_ALIVE === "true" ||
  process.env.VIBLY_E2E_KEEP_ALIVE_ON_SUCCESS === "true" ||
  process.env.VIBLY_E2E_KEEP_ALIVE_ON_FAILURE === "true";
const KEEP_ALIVE_ON_SUCCESS = KEEP_ALIVE || process.env.VIBLY_E2E_KEEP_ALIVE_ON_SUCCESS === "true";
const KEEP_ALIVE_ON_FAILURE = KEEP_ALIVE || process.env.VIBLY_E2E_KEEP_ALIVE_ON_FAILURE === "true";

type Json = Record<string, unknown>;

type AgentConfig = {
  id: string;
  principalId: string;
  roleHints: string[];
  skills: Record<string, number>;
  behavior: Record<string, unknown>;
};

type MechanismConfig = Record<string, unknown> & { id: string; name: string };

type ChainBinding = {
  identityId?: string;
  chainAgentId?: string;
};

const children: ChildProcessWithoutNullStreams[] = [];
let soloNodeHandle: SoloNodeHandle | undefined;
let paymentNodeHandle: SoloNodeHandle | undefined;
let indexerHandle: IndexerHandle | undefined;
let localProfile: E2eNetworkProfile | undefined;

class PauseExit extends Error {
  constructor(readonly boundary: PauseBoundary) {
    super(`Paused at ${boundary}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for live LLM E2E mode.");
  }
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  const requestedPause = process.env.VIBLY_E2E_PAUSE_AT;
  if (requestedPause && !isPauseBoundary(requestedPause)) {
    throw new Error(`Unsupported VIBLY_E2E_PAUSE_AT=${requestedPause}`);
  }

  if (RESUME_RUN && !HAS_EXPLICIT_RUN_NAME) {
    throw new Error("VIBLY_E2E_RUN_NAME is required when using e2e:live-llm:resume.");
  }

  const runName = sanitizeRunName(process.env.VIBLY_E2E_RUN_NAME ?? defaultRunName());
  const runRoot = liveRunDir(DATA_DIR, runName);
  if (RESET_RUN) {
    await rm(runRoot, { recursive: true, force: true });
  }
  await mkdir(runRoot, { recursive: true });
  const mode = EXTERNAL_COORDINATOR ? "external" : "local";
  const existingState = await loadLiveRunState(DATA_DIR, runName);
  if (existingState?.status === "passed" && !RESUME_RUN && !RESET_RUN) {
    throw new Error(
      [
        `Live run "${runName}" already passed.`,
        "Use VIBLY_E2E_RESET_RUN=true to start it fresh, VIBLY_E2E_RUN_NAME=<new-name> for a new named run,",
        "or pnpm e2e:live-llm:resume to inspect/resume the existing run.",
      ].join(" "),
    );
  }
  let state = existingState ??
    createInitialLiveRunState({ runName, mode });
  state = { ...state, status: "running", mode };
  await saveLiveRunState(DATA_DIR, state);

  const manageLocalNetwork = !EXTERNAL_COORDINATOR;
  const manageLocalStakePipeline = USE_REAL_STAKE && manageLocalNetwork;
  if (manageLocalNetwork) {
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
  }
  if (manageLocalStakePipeline) {
    if (!soloNodeHandle) throw new Error("Vibly chain was not initialized for live LLM stake pipeline.");
    indexerHandle = await startIndexer(soloNodeHandle.rpcPort);
  }

  const coordinator = await startCoordinator(runRoot, Boolean(state.organizationId));
  if (manageLocalNetwork && soloNodeHandle) {
    await rehydrateLocalGetVibClaimState(soloNodeHandle.wsUrl).catch((err) => {
      console.warn(`[e2e:live] Get VIB claim chain rehydrate skipped: ${String(err)}`);
    });
  }
  let consoleProcess: ChildProcessWithoutNullStreams | undefined;
  let completed = false;
  let reportPath: string | undefined;
  let contentReportPath: string | undefined;
  try {
    if (process.env.VIBLY_E2E_SKIP_CONSOLE !== "true") {
      consoleProcess = await startConsole();
    }

    if (state.pausedAt) {
      await resumeAgents(state);
      state = { ...state, status: "running", pausedAt: undefined, pausedReason: undefined };
      await saveLiveRunState(DATA_DIR, state);
    }

    state = await ensureSeeded(state);
    await checkpoint(state, "after-seed", requestedPause);
    state = markMilestone(state, "after-seed");
    await saveLiveRunState(DATA_DIR, state);

    const agents = await loadYaml<{ agents: AgentConfig[] }>("agents.yaml");
    await startAgentDaemons(agents.agents.filter((agent) => agent.behavior.lazy !== true), state.projectId!);

    if (!state.firstObservationTaskId) {
      state.firstObservationTaskId = await action("CreateObservationTask", state.guardianPrincipalId!, {
        organizationId: state.organizationId,
        projectId: state.projectId,
        title: "Live LLM observe Goldbach Program bootstrap gaps",
        description: "Read the handbook and knowledge base, then identify the most important missing research asset or next project step.",
        mechanismId: "mechanism_vibing_math_live",
      }).then((result) => result.aggregateRef.id);
      await saveLiveRunState(DATA_DIR, state);
    }

    await waitForObservation(state.firstObservationTaskId!);
    await checkpoint(state, "after-first-observation", requestedPause);
    state = markMilestone(state, "after-first-observation");
    await saveLiveRunState(DATA_DIR, state);

    const proposal = await waitForProposal(state.organizationId!);
    const proposalId = String(proposal.id);
    state.proposalId = proposalId;
    await checkpoint(state, "after-proposal", requestedPause);
    state = markMilestone(state, "after-proposal");
    await saveLiveRunState(DATA_DIR, state);

    const tasks = await waitForTasks(state.organizationId!, proposalId);
    state.taskIds = tasks.map((task) => String(task.id));
    const artifacts = await waitForArtifacts(state.organizationId!, state.taskIds);
    state.artifactIds = artifacts.map((artifact) => String(artifact.id));
    await checkpoint(state, "after-artifacts", requestedPause);
    state = markMilestone(state, "after-artifacts");
    await saveLiveRunState(DATA_DIR, state);

    await waitForKnowledgeSync(state.organizationId!, state.projectId!);
    await checkpoint(state, "after-knowledge-sync", requestedPause);
    state = markMilestone(state, "after-knowledge-sync");
    await saveLiveRunState(DATA_DIR, state);
    await checkpoint(state, "before-second-observation", requestedPause);
    state = markMilestone(state, "before-second-observation");
    await saveLiveRunState(DATA_DIR, state);

    if (!state.secondObservationTaskId) {
      state.secondObservationTaskId = await action("CreateObservationTask", state.guardianPrincipalId!, {
        organizationId: state.organizationId,
        projectId: state.projectId,
        title: "Live LLM observe next step after first research asset",
        description: "Use the updated knowledge base and propose the next project focus without recreating existing assets.",
        mechanismId: "mechanism_vibing_math_live",
      }).then((result) => result.aggregateRef.id);
      await saveLiveRunState(DATA_DIR, state);
    }
    await waitForObservation(state.secondObservationTaskId!);

    reportPath = path.join(REPORT_DIR, `live-llm-${Date.now()}.json`);
    contentReportPath = path.join(REPORT_DIR, `live-llm-content-${Date.now()}.md`);
    state = { ...state, status: "passed" };
    await saveLiveRunState(DATA_DIR, state);
    await writeFile(reportPath, JSON.stringify({ ...state, coordinatorUrl: COORDINATOR_URL }, null, 2));
    await writeFile(contentReportPath, await buildContentReport(state));
    console.log(`[e2e:live] live LLM Vibing Math passed. report=${reportPath}`);
    console.log(`[e2e:live] readable content report=${contentReportPath}`);
    completed = true;
  } catch (err) {
    if (err instanceof PauseExit) {
      return;
    }
    state = { ...state, status: "failed" };
    await saveLiveRunState(DATA_DIR, state);
    throw err;
  } finally {
    if ((completed && KEEP_ALIVE_ON_SUCCESS) || (!completed && KEEP_ALIVE_ON_FAILURE)) {
      printKeepAliveInfo({ state, reportPath, contentReportPath, consoleAvailable: Boolean(consoleProcess) });
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

async function ensureSeeded(state: LiveRunState): Promise<LiveRunState> {
  if (state.organizationId && state.projectId && state.guardianPrincipalId) return state;

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

  const guardianPrincipal = await post("/principals", {
    kind: "service",
    displayName: `live-guardian-${state.runName}`,
  }).then((body) => unwrapKey<Json>(body, "principal"));
  const guardian = String(guardianPrincipal.id);
  const orgId = await action("CreateOrganization", guardian, {
    name: "Live Vibing Math",
    description: "Persistent live LLM multi-agent E2E organization",
  }).then((result) => result.aggregateRef.id);
  await action("UpdateHandbook", guardian, {
    organizationId: orgId,
    handbook: {
      mission: orgHandbook,
      principles: [
        "Use ActionIntent for all state changes",
        "Build reusable research infrastructure before proof attempts",
      ],
      guardianPolicy: { guardian, powers: ["pause", "veto", "request_revision"] },
    },
  });
  const project = await post("/projects", {
    slug: `live-goldbach-${state.runName}-${Date.now()}`,
    name: "Live Goldbach Program",
    description: projectHandbook,
    sponsorPrincipalId: guardian,
    metadata: { organizationId: orgId, scenario: "live-llm-vibing-math", runName: state.runName },
  }).then((body) => unwrapKey<Json>(body, "project"));
  const projectId = String(project.id);

  const chainSeedReceipts: Record<string, ChainSeedReceipt> = {};
  for (const agent of agents.agents) {
    const capabilities = [...new Set([...agent.roleHints, ...Object.keys(agent.skills)])];
    const reputationScore = agent.id === "lazy-agent" ? 0.1 : 0.75;
    const binding = await resolveChainBinding(agent, guardian);

    await action("RegisterAgentProfile", guardian, {
      principalId: agent.principalId,
      displayName: agent.id,
      organizationIds: [orgId],
      capabilities,
      reputationScore,
      chainId: binding.identityId && binding.chainAgentId ? CHAIN_ID : undefined,
      identityId: binding.identityId,
      chainAgentId: binding.chainAgentId,
      dutyStatus: "active",
    });

    if (USE_REAL_STAKE && binding.identityId && binding.chainAgentId) {
      await waitForCoordinatorStakeSync(COORDINATOR_URL, API_TOKEN, agent.principalId, 60_000).catch((err) => {
        if (!EXTERNAL_COORDINATOR) throw err;
        console.warn(`[e2e:live] stake sync not confirmed for ${agent.principalId}: ${String(err)}`);
      });
    }

    await action("AddMember", guardian, {
      organizationId: orgId,
      principalId: agent.principalId,
      role: agent.roleHints[0] ?? "agent",
    });

    if (binding.receipt) chainSeedReceipts[agent.id] = binding.receipt;
  }

  for (const mechanism of mechanisms.mechanisms) {
    await action("UpsertMechanism", guardian, {
      ...mechanism,
      id: "mechanism_vibing_math_live",
      name: "vibing_math_live_llm_mechanism_v1",
      organizationId: orgId,
      projectId,
      timeout: { durationMs: 180_000, action: "select-backup" },
    });
  }
  for (const file of knowledgeFiles) {
    await action("SeedKnowledgeEntry", guardian, {
      organizationId: orgId,
      projectId,
      title: file,
      content: await readScenarioFile(`knowledge/${file}`),
      tags: ["initial", "goldbach", "live-llm"],
    });
  }

  const next = {
    ...state,
    guardianPrincipalId: guardian,
    organizationId: orgId,
    projectId,
    status: "running" as const,
  };
  await saveLiveRunState(DATA_DIR, next);
  console.log(`[e2e:live] seeded run=${state.runName} org=${orgId} project=${projectId} chainSeed=${Object.keys(chainSeedReceipts).length}`);
  return next;
}

async function resolveChainBinding(agent: AgentConfig, guardian: string): Promise<ChainBinding & { receipt?: ChainSeedReceipt }> {
  if (!USE_REAL_STAKE) {
    const identityId = `identity_${agent.id}`;
    const chainAgentId = `chain_agent_${agent.id}`;
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
    return { identityId, chainAgentId };
  }

  if (!EXTERNAL_COORDINATOR) {
    const receipt = await seedChainAgent({
      agentId: agent.id,
      coordinatorUrl: COORDINATOR_URL,
      apiToken: API_TOKEN,
      chainRpcUrl: `ws://127.0.0.1:${soloNodeHandle?.rpcPort ?? 9944}`,
      graphqlUrl: indexerHandle?.graphqlUrl ?? "http://127.0.0.1:3010/graphql",
      chainId: CHAIN_ID,
      bondAmount: "100",
    });
    return { identityId: receipt.identityId, chainAgentId: receipt.chainAgentId, receipt };
  }

  if (TESTNET_SEED) {
    const chainRpcUrl = process.env.VIBLY_E2E_CHAIN_RPC_URL ?? process.env.SUBSTRATE_RPC_URL;
    const graphqlUrl = process.env.VIBLY_E2E_INDEXER_URL ?? process.env.SUBSTRATE_INDEXER_URL;
    if (!chainRpcUrl || !graphqlUrl) {
      throw new Error("VIBLY_E2E_TESTNET_SEED=true requires VIBLY_E2E_CHAIN_RPC_URL/SUBSTRATE_RPC_URL and VIBLY_E2E_INDEXER_URL/SUBSTRATE_INDEXER_URL.");
    }
    const receipt = await seedChainAgent({
      agentId: agent.id,
      coordinatorUrl: COORDINATOR_URL,
      apiToken: API_TOKEN,
      chainRpcUrl,
      graphqlUrl,
      chainId: CHAIN_ID,
      bondAmount: process.env.VIBLY_E2E_TESTNET_BOND_AMOUNT ?? "100",
      rootSignerUri: process.env.VIBLY_E2E_ROOT_SIGNER_URI,
    });
    return { identityId: receipt.identityId, chainAgentId: receipt.chainAgentId, receipt };
  }

  const mapped = getAgentChainMap()[agent.id] ?? getAgentChainMap()[agent.principalId];
  if (mapped) return mapped;

  const existing = await get<Json>(`/agent-profiles/${agent.principalId}`)
    .then((body) => unwrapKey<Json>(body, "agent"))
    .catch(() => undefined);
  return {
    identityId: typeof existing?.identityId === "string" ? existing.identityId : undefined,
    chainAgentId: typeof existing?.chainAgentId === "string" ? existing.chainAgentId : undefined,
  };
}

function getAgentChainMap(): Record<string, ChainBinding> {
  const raw = process.env.VIBLY_E2E_AGENT_CHAIN_MAP;
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, ChainBinding>;
}

async function checkpoint(state: LiveRunState, boundary: PauseBoundary, requestedPause?: string): Promise<void> {
  if (!shouldPauseAt(state, boundary, requestedPause)) return;
  await waitForPublicObligationsClear(state);
  const reason = `live-run:${state.runName}:pause:${boundary}`;
  await pauseAgents(state, reason);
  await saveLiveRunState(DATA_DIR, {
    ...markMilestone(state, boundary),
    status: "paused",
    pausedAt: boundary,
    pausedReason: reason,
  });
  console.log(`[e2e:live] paused at ${boundary}. run=${state.runName}`);
  throw new PauseExit(boundary);
}

async function pauseAgents(state: LiveRunState, reason: string): Promise<void> {
  const agents = await loadYaml<{ agents: AgentConfig[] }>("agents.yaml");
  for (const agent of agents.agents.filter((item) => item.behavior.lazy !== true)) {
    await action("RequestAgentDutyPause", agent.principalId, {
      principalId: agent.principalId,
      reason,
    });
  }
}

async function resumeAgents(state: LiveRunState): Promise<void> {
  const agents = await loadYaml<{ agents: AgentConfig[] }>("agents.yaml");
  for (const agent of agents.agents.filter((item) => item.behavior.lazy !== true)) {
    await action("ResumeAgentDuty", agent.principalId, { principalId: agent.principalId })
      .catch((err) => console.warn(`[e2e:live] resume skipped for ${agent.principalId}: ${String(err)}`));
  }
  console.log(`[e2e:live] resumed agents for run=${state.runName}`);
}

async function waitForPublicObligationsClear(state: LiveRunState): Promise<void> {
  const agents = await loadYaml<{ agents: AgentConfig[] }>("agents.yaml");
  await waitFor(async () => {
    for (const agent of agents.agents.filter((item) => item.behavior.lazy !== true)) {
      const inbox = await getInbox(agent.principalId, state.organizationId!, state.projectId!);
      if (hasBlockingObligation(inbox, agent.principalId)) return undefined;
    }
    return true;
  }, "public obligations clear before pause", 180_000);
}

function hasBlockingObligation(inbox: Json, principalId: string): boolean {
  for (const offer of (inbox.assignmentOffers as Json[] | undefined) ?? []) {
    const task = offer.observationTask as Json | undefined;
    if ((offer.status === "offered" || offer.status === "accepted") && task?.status !== "completed") return true;
  }
  for (const discussion of (inbox.discussionParticipations as Json[] | undefined) ?? []) {
    const round = Array.isArray(discussion.rounds) ? discussion.rounds[0] as Json | undefined : undefined;
    const contributions = Array.isArray(round?.contributions) ? round.contributions as Json[] : [];
    if (!contributions.some((item) => item.authorId === principalId)) return true;
  }
  if (((inbox.reviewRequests as Json[] | undefined) ?? []).length > 0) return true;
  for (const task of (inbox.availableTasks as Json[] | undefined) ?? []) {
    if (task.assigneeId === principalId && ["claimed", "in-progress", "submitted"].includes(String(task.status))) return true;
  }
  return ((inbox.notifications as Json[] | undefined) ?? []).some((item) => item.type === "ProposalCreationRequest" && item.status === "open");
}

async function startAgentDaemons(agents: AgentConfig[], projectId: string): Promise<void> {
  const runName = sanitizeRunName(process.env.VIBLY_E2E_RUN_NAME ?? "live-vibing-math");
  const started: Array<{ agentId: string; child: ChildProcessWithoutNullStreams }> = [];
  for (const agent of agents) {
    const home = path.join(DATA_DIR, "live-runs", runName, "clients", agent.id);
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
          sync: { enableSse: true },
          daemon: {
            llmE2E: true,
            autoClaimRewards: true,
          },
        },
      },
    }, null, 2));

    const child = spawn("pnpm", ["--dir", path.resolve(ROOT, "../vibly-client"), "dev", "--", "daemon", "start", "--interval", "1500"], {
      env: {
        ...process.env,
        VIBLY_HOME: home,
        VIBLY_API_TOKEN: API_TOKEN,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        OPENAI_MODEL: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      },
      stdio: "pipe",
    });
    pipeChild(`live-agent:${agent.id}`, child);
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
        `Live agent daemons exited before the run could continue: ${failed.join(", ")}.`,
        "Install vibly-client dependencies first: cd ../vibly-client && pnpm install",
      ].join(" "),
    );
  }
}

async function startCoordinator(runRoot: string, preserveDb: boolean): Promise<ChildProcessWithoutNullStreams> {
  if (EXTERNAL_COORDINATOR) {
    await waitForHealth(COORDINATOR_URL, COORDINATOR_START_TIMEOUT_MS);
    return fakeChild();
  }
  await assertPortAvailable({
    port: COORDINATOR_PORT,
    serviceName: "Live LLM coordinator",
    portEnv: "VIBLY_E2E_COORDINATOR_PORT",
    externalModeEnv: "VIBLY_E2E_EXTERNAL_COORDINATOR",
  });
  const dbPath = path.join(runRoot, "coordinator.sqlite");
  if (!preserveDb) {
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-shm`, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
  }

  const stakeEnv: Record<string, string> = USE_REAL_STAKE
    ? {
        SUBSTRATE_INDEXER_URL: indexerHandle?.graphqlUrl ?? "http://127.0.0.1:3010/graphql",
        AGENT_STAKE_SYNC_INTERVAL_MS: "500",
        SUBSTRATE_STAKE_TX_MODE: "fixture",
        SUBSTRATE_CHAIN_ID: CHAIN_ID,
      }
    : {};

  const getVibLocalEnv: Record<string, string> = ENABLE_GET_VIB_LOCAL
    ? {
        VIBLY_DOT_RECEIVING_ADDRESS: process.env.VIBLY_DOT_RECEIVING_ADDRESS ?? process.env.VIBLY_E2E_GET_VIB_DEPOSIT_ADDRESS ?? DEFAULT_GET_VIB_DEPOSIT_ADDRESS,
        GET_VIB_RELAY_RPC_URL: process.env.GET_VIB_RELAY_RPC_URL ?? process.env.VIBLY_E2E_GET_VIB_RELAY_RPC ?? localProfile?.paymentRpcUrls[0] ?? "",
        GET_VIB_RELAY_CHAIN_ID: process.env.GET_VIB_RELAY_CHAIN_ID ?? process.env.VIBLY_E2E_GET_VIB_RELAY_CHAIN_ID ?? "polkadot-local",
        GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: process.env.GET_VIB_DEPOSIT_SCAN_INTERVAL_MS ?? process.env.VIBLY_E2E_GET_VIB_SCAN_INTERVAL_MS ?? "1500",
        GET_VIB_DEPOSIT_FINALITY_BLOCKS: process.env.GET_VIB_DEPOSIT_FINALITY_BLOCKS ?? process.env.VIBLY_E2E_GET_VIB_FINALITY_BLOCKS ?? "1",
        GET_VIB_RELAY_TOKEN_DECIMALS: process.env.GET_VIB_RELAY_TOKEN_DECIMALS ?? process.env.VIBLY_E2E_GET_VIB_RELAY_DECIMALS ?? "10",
        GET_VIB_ROOT_UPLOAD_INTERVAL_MS: process.env.GET_VIB_ROOT_UPLOAD_INTERVAL_MS ?? "120000",
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
      ASSIGNMENT_EXPIRY_INTERVAL_MS: process.env.ASSIGNMENT_EXPIRY_INTERVAL_MS ?? "500",
      ...stakeEnv,
      ...getVibLocalEnv,
    },
    stdio: "pipe",
  });
  pipeChild("coordinator", child);
  children.push(child);
  await waitForHealth(COORDINATOR_URL, COORDINATOR_START_TIMEOUT_MS);
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
      AUTH_SECRET: "vibly-e2e-live-secret",
      AUTH_DEV_CREDENTIALS: "true",
      NEXT_PUBLIC_VIBLY_NETWORK_PROFILES: publicConsoleNetworkProfiles(resolveConsoleLocalProfile()),
      VIBLY_COORDINATOR_NETWORK_PROFILES: serverCoordinatorNetworkProfiles(resolveConsoleLocalProfile()),
      NEXT_PUBLIC_VIBLY_NETWORK_ID: defaultConsoleNetworkId(),
      NEXT_PUBLIC_VIBLY_NETWORK_NAME: defaultConsoleNetworkName(),
      NEXT_PUBLIC_VIBLY_RPC_URL: resolveConsoleLocalProfile().viblyRpcUrls[0] ?? "",
      NEXT_PUBLIC_PAYMENT_RPC_URL: resolveConsoleLocalProfile().paymentRpcUrls[0] ?? "",
      NEXT_PUBLIC_POLKADOT_RPC_URL: resolveConsoleLocalProfile().paymentRpcUrls[0] ?? "",
      PORT: String(CONSOLE_PORT),
    }),
    stdio: "pipe",
  });
  pipeChild("console", child);
  children.push(child);
  await waitForHttpWithChild(`${consoleOrigin}/personal-center`, consoleStartTimeoutMs(), child);
  return child;
}

function defaultConsoleNetworkId(): string {
  return EXTERNAL_COORDINATOR ? "substrate:vibly-testnet" : resolveConsoleLocalProfile().id;
}

function defaultConsoleNetworkName(): string {
  return EXTERNAL_COORDINATOR ? "Lumen" : resolveConsoleLocalProfile().label;
}

function resolveConsoleLocalProfile(): E2eNetworkProfile {
  return localProfile ?? localNetworkProfile({
    coordinatorUrl: COORDINATOR_URL,
    viblyRpcUrl: process.env.VIBLY_E2E_CHAIN_RPC_URL ?? process.env.SUBSTRATE_RPC_URL ?? "",
    paymentRpcUrl: process.env.VIBLY_E2E_GET_VIB_RELAY_RPC ?? process.env.GET_VIB_RELAY_RPC_URL ?? "",
  });
}

async function waitForObservation(observationTaskId: string): Promise<Json> {
  return waitFor(async () => {
    const items = await list<Json>("/observations", { limit: 200 });
    return items.find((item) => item.observationTaskId === observationTaskId);
  }, `observation for ${observationTaskId}`, 240_000);
}

async function waitForProposal(organizationId: string): Promise<Json> {
  return waitFor(async () => {
    const items = await list<Json>("/proposals", { organizationId, limit: 200 });
    return items.find((item) => String(item.title ?? item.body ?? "").toLowerCase().includes("goldbach") ||
      String(item.title ?? item.body ?? "").toLowerCase().includes("literature"));
  }, "live LLM proposal", 300_000);
}

async function waitForTasks(organizationId: string, proposalId: string): Promise<Json[]> {
  return waitFor(async () => {
    const items = await list<Json>("/tasks", { organizationId, limit: 200 });
    const relevant = items.filter((item) => item.proposalId === proposalId);
    return relevant.length > 0 ? relevant : undefined;
  }, "live LLM proposal tasks", 180_000);
}

async function waitForArtifacts(organizationId: string, taskIds: string[]): Promise<Json[]> {
  return waitFor(async () => {
    const items = await list<Json>("/artifacts", { organizationId, limit: 200 });
    const relevant = items.filter((item) => taskIds.includes(String(item.taskId)));
    return relevant.length >= taskIds.length ? relevant : undefined;
  }, "live LLM artifacts", 420_000);
}

async function waitForKnowledgeSync(organizationId: string, projectId: string): Promise<void> {
  await waitFor(async () => {
    const inbox = await getInbox("principal_observer_2", organizationId, projectId);
    const entries = ((inbox.knowledgeSnapshot as Json | undefined)?.entries as Json[] | undefined) ?? [];
    return entries.some((entry) => String(entry.title ?? entry.content ?? "").toLowerCase().includes("literature"))
      ? true
      : undefined;
  }, "live LLM knowledge sync", 240_000);
}

async function buildContentReport(state: LiveRunState): Promise<string> {
  const organizationId = state.organizationId!;
  const projectId = state.projectId!;
  const [observations, proposals, discussions, reviewRounds, tasks, artifacts, observerInbox] = await Promise.all([
    list<Json>("/observations", { organizationId, limit: 200 }),
    list<Json>("/proposals", { organizationId, limit: 200 }),
    list<Json>("/discussions", { organizationId, limit: 200 }),
    list<Json>("/review-rounds", { organizationId, limit: 200 }),
    list<Json>("/tasks", { organizationId, limit: 200 }),
    list<Json>("/artifacts", { organizationId, limit: 200 }),
    getInbox("principal_observer_2", organizationId, projectId).catch(() => ({} as Json)),
  ]);
  const knowledgeEntries = (((observerInbox.knowledgeSnapshot as Json | undefined)?.entries as Json[] | undefined) ?? [])
    .filter((entry) => entry.projectId === projectId || entry.projectId === undefined);

  return [
    `# Live LLM Vibing Math Content`,
    ``,
    `- Run: ${state.runName}`,
    `- Organization: ${organizationId}`,
    `- Project: ${projectId}`,
    `- Proposal: ${state.proposalId ?? ""}`,
    ``,
    `## Observations`,
    ...observations.map((item) => [
      `### ${String(item.title ?? item.id ?? "Observation")}`,
      ``,
      observationBody(item),
      ``,
    ].join("\n")),
    `## Proposals`,
    ...proposals.map((item) => [
      `### ${String(item.title ?? item.id ?? "Proposal")}`,
      ``,
      String(item.body ?? ""),
      ``,
      `Tasks:`,
      "```json",
      JSON.stringify(item.suggestedTaskPlan ?? [], null, 2),
      "```",
      ``,
    ].join("\n")),
    `## Discussion Contributions`,
    ...discussions.map((discussion) => discussionSection(discussion)),
    `## Reviews`,
    ...reviewRounds.map((round) => reviewSection(round)),
    `## Tasks`,
    ...tasks.map((task) => [
      `### ${String(task.title ?? task.id ?? "Task")}`,
      ``,
      String(task.description ?? ""),
      ``,
      `Status: ${String(task.status ?? "")}`,
      ``,
    ].join("\n")),
    `## Artifacts`,
    ...artifacts.map((artifact) => [
      `### ${String(artifact.title ?? artifact.id ?? "Artifact")}`,
      ``,
      String(artifact.description ?? ""),
      ``,
      `Status: ${String(artifact.status ?? "")}`,
      ``,
    ].join("\n")),
    `## Knowledge Entries`,
    ...knowledgeEntries.map((entry) => [
      `### ${String(entry.title ?? entry.id ?? "Knowledge")}`,
      ``,
      String(entry.content ?? entry.summary ?? ""),
      ``,
    ].join("\n")),
  ].join("\n");
}

function observationBody(item: Json): string {
  const direct = String(item.content ?? item.body ?? item.summary ?? "").trim();
  if (direct) return direct;

  const findings = Array.isArray(item.findings)
    ? (item.findings as Json[])
      .map((entry) => {
        const title = String(entry.title ?? entry.name ?? "").trim();
        const description = String(entry.description ?? entry.detail ?? entry.content ?? "").trim();
        if (title && description) return `- ${title}: ${description}`;
        if (title) return `- ${title}`;
        if (description) return `- ${description}`;
        return "";
      })
      .filter(Boolean)
      .join("\n")
    : "";

  const risks = Array.isArray(item.risks)
    ? (item.risks as unknown[])
      .map((entry) => {
        if (typeof entry === "string") return entry.trim();
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const record = entry as Json;
          return String(record.title ?? record.reason ?? record.description ?? "").trim();
        }
        return "";
      })
      .filter(Boolean)
      .map((line) => `- ${line}`)
      .join("\n")
    : "";

  const actions = Array.isArray(item.suggestedActions)
    ? (item.suggestedActions as Json[])
      .map((entry) => {
        const actionType = String(entry.type ?? "").trim();
        const title = String(entry.title ?? entry.name ?? "").trim();
        const description = String(entry.description ?? entry.detail ?? entry.content ?? "").trim();
        const head = [actionType, title].filter(Boolean).join(" · ");
        if (head && description) return `- ${head}: ${description}`;
        if (head) return `- ${head}`;
        if (description) return `- ${description}`;
        return "";
      })
      .filter(Boolean)
      .join("\n")
    : "";

  const sections = [
    findings ? `Findings\n${findings}` : "",
    risks ? `Risks\n${risks}` : "",
    actions ? `Suggested Actions\n${actions}` : "",
  ].filter(Boolean);

  return sections.join("\n\n");
}

function discussionSection(discussion: Json): string {
  const rounds = Array.isArray(discussion.rounds) ? discussion.rounds as Json[] : [];
  const contributions = rounds.flatMap((round) => Array.isArray(round.contributions) ? round.contributions as Json[] : []);
  return [
    `### ${String(discussion.title ?? discussion.id ?? "Discussion")}`,
    ``,
    ...contributions.map((item) => `- ${String(item.authorId ?? "agent")}: ${String(item.content ?? "").replace(/\n+/g, "\n  ")}`),
    discussion.outcome ? `\nOutcome: ${JSON.stringify(discussion.outcome, null, 2)}` : "",
    ``,
  ].join("\n");
}

function reviewSection(round: Json): string {
  const reviews = Array.isArray(round.reviews) ? round.reviews as Json[] : [];
  return [
    `### ${String(round.targetRef ? JSON.stringify(round.targetRef) : round.id ?? "Review round")}`,
    ``,
    ...reviews.map((item) => `- ${String(item.reviewerId ?? "reviewer")}: ${String(item.outcome ?? "")} - ${String(item.comment ?? "")}`),
    ``,
  ].join("\n");
}

async function getInbox(principalId: string, organizationId: string, projectId: string): Promise<Json> {
  const body = await get<Json>(`/agents/${principalId}/inbox`, { organizationId, projectId, limit: 100 });
  return unwrapKey<Json>(body, "inbox");
}

async function action(type: string, principalId: string, payload: Json): Promise<{ aggregateRef: { id: string; kind: string } }> {
  const body = await post("/action-intents", { type, principalId, payload });
  return unwrapData<{ aggregateRef: { id: string; kind: string } }>(body);
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
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function waitForHealth(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  await waitForHttp(`${baseUrl}/health`, timeoutMs);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => undefined);
    return response?.ok ? true : undefined;
  }, url, timeoutMs);
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

function defaultRunName(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/u, "").replace("T", "-");
  return `live-vibing-math-${stamp}`;
}

function printKeepAliveInfo(input: {
  state: LiveRunState;
  reportPath?: string;
  contentReportPath?: string;
  consoleAvailable: boolean;
}): void {
  console.log("");
  console.log("[e2e:live] Keep-alive mode enabled.");
  console.log("[e2e:live] Processes and data are being left running for inspection.");
  console.log(`[e2e:live] Coordinator: ${COORDINATOR_URL}`);
  if (input.consoleAvailable) {
    console.log(`[e2e:live] Console: http://localhost:${CONSOLE_PORT}`);
    console.log(`[e2e:live] Console (127.0.0.1): http://127.0.0.1:${CONSOLE_PORT}`);
    if (input.state.projectId) console.log(`[e2e:live] Project page: http://localhost:${CONSOLE_PORT}/projects/${input.state.projectId}`);
    if (input.state.proposalId) console.log(`[e2e:live] Proposal page: http://localhost:${CONSOLE_PORT}/proposals/${input.state.proposalId}`);
    const networkAddress = getFirstNetworkAddress();
    if (networkAddress) console.log(`[e2e:live] Console (WSL/LAN): http://${networkAddress}:${CONSOLE_PORT}`);
  } else {
    console.log("[e2e:live] Console: not started");
  }
  if (input.state.organizationId) console.log(`[e2e:live] Organization: ${input.state.organizationId}`);
  if (input.state.projectId) console.log(`[e2e:live] Project: ${input.state.projectId}`);
  if (input.state.proposalId) console.log(`[e2e:live] Proposal: ${input.state.proposalId}`);
  if (input.reportPath) console.log(`[e2e:live] Report: ${input.reportPath}`);
  if (input.contentReportPath) console.log(`[e2e:live] Content report: ${input.contentReportPath}`);
  console.log(`[e2e:live] State: ${path.join(liveRunDir(DATA_DIR, input.state.runName), "state.json")}`);
  console.log("[e2e:live] Press Ctrl+C when finished inspecting; cleanup will run afterward.");
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

async function rehydrateLocalGetVibClaimState(rpcUrl: string): Promise<void> {
  const statusBody = await get<Json>("/admin/get-vib/root-uploader/status");
  const status = (unwrapData<Json>(statusBody).status ?? {}) as Json;
  const manifest = status.latestManifest as Json | undefined;
  if (!manifest?.networkId || !manifest.rootVersion || !manifest.merkleRoot) return;

  const coordinatorEnv = await readCoordinatorEnv();
  const publisherUri = coordinatorEnv.GET_VIB_ROOT_PUBLISHER_URI ?? process.env.GET_VIB_ROOT_PUBLISHER_URI;
  if (!publisherUri) return;

  const [{ ApiPromise, WsProvider }, { Keyring }, { cryptoWaitReady, encodeAddress }] = await Promise.all([
    import("@polkadot/api"),
    import("@polkadot/keyring"),
    import("@polkadot/util-crypto"),
  ]);
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(rpcUrl) });
  try {
    const keyring = new Keyring({ type: "sr25519" });
    const sudo = keyring.addFromUri("//Alice");
    const publisher = keyring.addFromUri(publisherUri);
    const reserve = encodeAddress(new Uint8Array(32).fill(7), 42);
    const rootVersion = Number(manifest.rootVersion);
    const merkleRoot = String(manifest.merkleRoot);
    const totalCumulativeBaseUnits = decimalToBaseUnits(String(manifest.totalCumulativeAmount ?? "0"), 12);
    const currentRoot = await api.query.vibClaim.claimRoot() as unknown as { isSome?: boolean; unwrap?: () => Json };
    const current = currentRoot.isSome && typeof currentRoot.unwrap === "function" ? currentRoot.unwrap() : undefined;
    const currentRootVersion = Number((current?.rootVersion as { toString?: () => string } | undefined)?.toString?.() ?? 0);
    const currentMerkleRoot = (current?.merkleRoot as { toHex?: () => string } | undefined)?.toHex?.();
    const needsRoot = currentRootVersion !== rootVersion || currentMerkleRoot !== merkleRoot;
    if (!needsRoot) return;

    const configuredPublisher = await api.query.vibClaim.claimRootPublisher() as unknown as { toString(): string };
    if (configuredPublisher.toString() !== publisher.address) {
      await signAndWaitLocal(
        api.tx.sudo.sudo(api.tx.vibClaim.setClaimRootPublisher(publisher.address)),
        sudo,
        "vibClaim.setClaimRootPublisher",
      );
    }

    const publisherAccount = await api.query.system.account(publisher.address) as unknown as { data: { free: { toString(): string } } };
    if (BigInt(publisherAccount.data.free.toString()) < 1_000_000_000_000n) {
      await signAndWaitLocal(
        api.tx.balances.transferAllowDeath
          ? api.tx.balances.transferAllowDeath(publisher.address, 10_000_000_000_000n)
          : api.tx.balances.transfer(publisher.address, 10_000_000_000_000n),
        sudo,
        "balances.transferAllowDeath",
      );
    }

    if (!api.tx.balances.forceSetBalance) throw new Error("balances.forceSetBalance is unavailable");
    const reserveTarget = BigInt(totalCumulativeBaseUnits) + 10_000_000n * 10n ** 12n;
    const reserveAccount = await api.query.system.account(reserve) as unknown as { data: { free: { toString(): string } } };
    if (BigInt(reserveAccount.data.free.toString()) < reserveTarget) {
      await signAndWaitLocal(
        api.tx.sudo.sudo(api.tx.balances.forceSetBalance(reserve, reserveTarget)),
        sudo,
        "balances.forceSetBalance",
      );
    }

    await signAndWaitLocal(
      api.tx.vibClaim.setClaimRoot(
        String(manifest.networkId),
        rootVersion,
        merkleRoot,
        totalCumulativeBaseUnits,
        String(manifest.metadataHash),
      ),
      publisher,
      "vibClaim.setClaimRoot",
    );
    console.log(`[e2e:live] Rehydrated Get VIB claim root v${rootVersion} on local chain.`);
  } finally {
    await api.disconnect();
  }
}

async function readCoordinatorEnv(): Promise<Record<string, string>> {
  const envPath = path.resolve(ROOT, "../vibly-coordinator/.env");
  if (!existsSync(envPath)) return {};
  const text = await readFile(envPath, "utf8");
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 0) continue;
    env[line.slice(0, index)] = parseEnvValue(line.slice(index + 1));
  }
  return env;
}

function parseEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith("\"") && trimmed.endsWith("\""))) return trimmed.slice(1, -1);
  return trimmed;
}

async function signAndWaitLocal(
  tx: unknown,
  signer: unknown,
  label: string,
): Promise<void> {
  const submittable = tx as {
    signAndSend: (
      signer: unknown,
      callback: (result: {
        dispatchError?: { toString(): string };
        events?: Array<{ event: { section: string; method: string; data: unknown[] } }>;
        status: { isInBlock: boolean; isFinalized: boolean };
      }) => void,
    ) => Promise<() => void>;
  };
  await new Promise<void>((resolve, reject) => {
    void submittable.signAndSend(signer, (result) => {
      if (result.dispatchError) {
        reject(new Error(`${label}: ${result.dispatchError.toString()}`));
        return;
      }
      const sudoFailed = result.events?.find((item) => item.event.section === "sudo" && item.event.method === "Sudid" && String(item.event.data[0]).startsWith("Err"));
      if (sudoFailed) {
        reject(new Error(`${label}: ${String(sudoFailed.event.data[0])}`));
        return;
      }
      if (result.status.isInBlock || result.status.isFinalized) resolve();
    }).catch(reject);
  });
}

function decimalToBaseUnits(value: string, decimals: number): string {
  const [wholeRaw, fractionRaw = ""] = value.split(".");
  const whole = wholeRaw || "0";
  const fraction = `${fractionRaw}${"0".repeat(decimals)}`.slice(0, decimals);
  return String(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || "0"));
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
  if (indexerHandle) await stopIndexer();
  if (soloNodeHandle) await stopSoloNode(soloNodeHandle);
}

if (!existsSync(SCENARIO)) throw new Error(`Scenario directory not found: ${SCENARIO}`);

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await cleanupForSignal();
    process.exit(1);
  });
