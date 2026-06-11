import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
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
  liveRunStatePath,
  loadLiveRunState,
  markMilestone,
  saveLiveRunState,
  sanitizeRunName,
  shouldPauseAt,
  type LiveRunState,
  type LiveRunFailure,
  type LiveRunAction,
  type PauseBoundary,
} from "./liveState.js";
import {
  HttpResponseError,
  LiveActionError,
  type LiveActionErrorContext,
} from "./liveErrors.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCENARIO = path.join(ROOT, "scenarios", "vibing-math");
const REPORT_DIR = path.join(ROOT, "reports");
const DATA_DIR = path.join(ROOT, "data");
const PROFILE = process.env.VIBLY_E2E_PROFILE ?? "default";
const IS_LUMEN_PROFILE = PROFILE === "lumen";
const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const CONSOLE_PORT = Number(process.env.VIBLY_E2E_CONSOLE_PORT ?? "3001");
const PAYMENT_CHAIN_RPC_PORT = Number(process.env.VIBLY_E2E_PAYMENT_CHAIN_RPC_PORT ?? "9945");
const COORDINATOR_URL =
  process.env.COORDINATOR_URL ??
  process.env.LUMEN_COORDINATOR_URL ??
  `http://127.0.0.1:${COORDINATOR_PORT}`;
const COORDINATOR_START_TIMEOUT_MS = Number(process.env.VIBLY_E2E_COORDINATOR_START_TIMEOUT_MS ?? "120000");
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";
const CHAIN_ID =
  process.env.VIBLY_E2E_CHAIN_ID ??
  (IS_LUMEN_PROFILE ? "substrate:vibly-testnet" : "substrate:vibly-solo");
const USE_REAL_STAKE = resolveUseRealStake("e2e:live-llm");
const ENABLE_GET_VIB_LOCAL = process.env.VIBLY_E2E_ENABLE_GET_VIB_LOCAL === "true";
const DEFAULT_GET_VIB_DEPOSIT_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const EXTERNAL_COORDINATOR = process.env.VIBLY_E2E_EXTERNAL_COORDINATOR === "true";
const TESTNET_SEED = process.env.VIBLY_E2E_TESTNET_SEED === "true";
const RESUME_RUN = process.env.VIBLY_E2E_RESUME === "true";
const RESET_RUN = process.env.VIBLY_E2E_RESET_RUN === "true";
const HAS_EXPLICIT_RUN_NAME = Boolean(process.env.VIBLY_E2E_RUN_NAME);
const AGENT_DUTY_COMMAND = process.env.VIBLY_E2E_AGENT_DUTY_COMMAND;

// ── Keep-alive semantics (Issue 7) ───────────────────────────────────────
// VIBLY_E2E_KEEP_ALIVE=true → keep alive on both success and failure.
// *_ON_SUCCESS / *_ON_FAILURE → scoped.
const KEEP_ALIVE_ALWAYS = process.env.VIBLY_E2E_KEEP_ALIVE === "true";
const KEEP_ALIVE_ON_SUCCESS =
  KEEP_ALIVE_ALWAYS || process.env.VIBLY_E2E_KEEP_ALIVE_ON_SUCCESS === "true";
const KEEP_ALIVE_ON_FAILURE =
  KEEP_ALIVE_ALWAYS || process.env.VIBLY_E2E_KEEP_ALIVE_ON_FAILURE === "true";

// ── Coordinator client version headers ───────────────────────────────────
// These prevent HTTP 426 UPGRADE_REQUIRED when the coordinator has
// CLIENT_VERSION_ENFORCEMENT=true.
const E2E_CLIENT_VERSION =
  process.env.VIBLY_E2E_CLIENT_VERSION ??
  "0.1.1";

const E2E_CONTRACT_VERSION =
  process.env.VIBLY_E2E_CONTRACT_VERSION ??
  "0.1.1";

const E2E_PROTOCOL_VERSION =
  process.env.VIBLY_E2E_PROTOCOL_VERSION ??
  "0.2";

const E2E_CLIENT_PACKAGE =
  process.env.VIBLY_E2E_CLIENT_PACKAGE ??
  "vibly-e2e-lab";

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

// ── Lumen external mode early config check (Issue 9) ──────────────────────
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

if (IS_LUMEN_PROFILE && EXTERNAL_COORDINATOR) {
  requireEnv("OPENAI_API_KEY");
  if (API_TOKEN === "dev-token") {
    throw new Error(
      "COORDINATOR_API_TOKEN is still the default value in external Lumen mode.\n" +
      "Set a real coordinator API token.",
    );
  }
  requireEnv("LUMEN_COORDINATOR_URL");
  requireEnv("LUMEN_CHAIN_RPC_URL");
  requireEnv("LUMEN_INDEXER_GRAPHQL_URL");
  requireEnv("VIBLY_E2E_ORGANIZATION_ID");
  requireEnv("VIBLY_E2E_PROJECT_ID");
}

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

  if (AGENT_DUTY_COMMAND && !HAS_EXPLICIT_RUN_NAME) {
    throw new Error("VIBLY_E2E_RUN_NAME is required when using VIBLY_E2E_AGENT_DUTY_COMMAND.");
  }

  const runName = sanitizeRunName(process.env.VIBLY_E2E_RUN_NAME ?? defaultRunName());
  const runRoot = liveRunDir(DATA_DIR, runName);

  // ── Agent duty command (pause/resume) ───────────────────────────────────
  if (AGENT_DUTY_COMMAND) {
    const existingState = await loadLiveRunState(DATA_DIR, runName);
    if (!existingState) {
      throw new Error(`Live run "${runName}" was not found for agent duty command.`);
    }

    if (AGENT_DUTY_COMMAND === "pause") {
      const reason = `manual:${runName}:pause`;
      await pauseAgents(existingState, reason);
      await saveLiveRunState(DATA_DIR, {
        ...existingState,
        status: "paused",
        pausedReason: reason,
      });
      console.log(`[e2e:live] manually paused agents for run=${runName}`);
      return;
    }

    if (AGENT_DUTY_COMMAND === "resume") {
      await resumeAgents(existingState);
      await saveLiveRunState(DATA_DIR, {
        ...existingState,
        status: "running",
        pausedAt: undefined,
        pausedReason: undefined,
      });
      console.log(`[e2e:live] manually resumed agents for run=${runName}`);
      return;
    }

    throw new Error(`Unsupported VIBLY_E2E_AGENT_DUTY_COMMAND=${AGENT_DUTY_COMMAND}`);
  }

  if (RESET_RUN) {
    await rm(runRoot, { recursive: true, force: true });
  }
  await mkdir(runRoot, { recursive: true });
  setPipeLogDir(runRoot);
  console.log(
    `[e2e:live] coordinator client version headers: package=${E2E_CLIENT_PACKAGE} client=${E2E_CLIENT_VERSION} contract=${E2E_CONTRACT_VERSION} protocol=${E2E_PROTOCOL_VERSION}`,
  );
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
  let failureReportPaths: { reportPath: string; readablePath: string } | undefined;
  try {
    if (process.env.VIBLY_E2E_SKIP_CONSOLE !== "true") {
      consoleProcess = await startConsole();
    }

    if (state.pausedAt) {
      await resumeAgents(state);
      state = { ...state, status: "running", pausedAt: undefined, pausedReason: undefined };
      await saveLiveRunState(DATA_DIR, state);
    }

    // ── Lumen identity-first preflight ────────────────────────────────────
    if (IS_LUMEN_PROFILE && process.env.VIBLY_E2E_SKIP_LUMEN_PREFLIGHT !== "true") {
      state = await setPhase(state, "preflight");
      const { runLumenPreflight } = await import("./lumenPreflight.js");
      const preflight = await runLumenPreflight();
      console.log(`[e2e:live] Lumen preflight passed: ${preflight.agents.agents.length} agents cached`);
    }

    state = await setPhase(state, "ensure-seeded");
    state = await ensureSeeded(state);
    state = await setPhase(state, "after-seed");
    await checkpoint(state, "after-seed", requestedPause);
    state = markMilestone(state, "after-seed");
    await saveLiveRunState(DATA_DIR, state);

    const agents = await loadYaml<{ agents: AgentConfig[] }>("agents.yaml");
    state = await setPhase(state, "start-agent-daemons");
    await startAgentDaemons(
      agents.agents.filter((agent) => agent.behavior.lazy !== true),
      state.guardianPrincipalId!,
      state.organizationId!,
      state.projectId!,
    );

    state = await setPhase(state, "create-first-observation-task");
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

    state = await setPhase(state, "wait-first-observation");
    await waitForObservation(state.firstObservationTaskId!);
    await checkpoint(state, "after-first-observation", requestedPause);
    state = markMilestone(state, "after-first-observation");
    await saveLiveRunState(DATA_DIR, state);

    state = await setPhase(state, "wait-proposal");
    const proposal = await waitForProposal(state.organizationId!);
    const proposalId = String(proposal.id);
    state.proposalId = proposalId;
    await checkpoint(state, "after-proposal", requestedPause);
    state = markMilestone(state, "after-proposal");
    await saveLiveRunState(DATA_DIR, state);

    state = await setPhase(state, "wait-tasks");
    const tasks = await waitForTasks(state.organizationId!, proposalId);
    state.taskIds = tasks.map((task) => String(task.id));
    state = await setPhase(state, "wait-artifacts");
    const artifacts = await waitForArtifacts(state.organizationId!, state.taskIds);
    state.artifactIds = artifacts.map((artifact) => String(artifact.id));
    await checkpoint(state, "after-artifacts", requestedPause);
    state = markMilestone(state, "after-artifacts");
    await saveLiveRunState(DATA_DIR, state);

    state = await setPhase(state, "wait-knowledge-sync");
    await waitForKnowledgeSync(state.organizationId!, state.projectId!);
    await checkpoint(state, "after-knowledge-sync", requestedPause);
    state = markMilestone(state, "after-knowledge-sync");
    await saveLiveRunState(DATA_DIR, state);
    await checkpoint(state, "before-second-observation", requestedPause);
    state = markMilestone(state, "before-second-observation");
    await saveLiveRunState(DATA_DIR, state);

    state = await setPhase(state, "create-second-observation-task");
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
    state = await setPhase(state, "wait-second-observation");
    await waitForObservation(state.secondObservationTaskId!);

    state = await setPhase(state, "build-report");
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

    // ── Failure handling (Issues 1, 6) ───────────────────────────────────
    // Reload latest state from disk and merge with in-memory state
    const latestOnDisk = await loadLiveRunState(DATA_DIR, runName);

    // Build merged state: prefer disk version for fields that may have been
    // persisted (orgId, projectId, etc.), fall back to memory state
    const merged = {
      ...state,
      ...latestOnDisk,
      // Keep the most complete set of key identifiers
      guardianPrincipalId: state.guardianPrincipalId ?? latestOnDisk?.guardianPrincipalId,
      organizationId: state.organizationId ?? latestOnDisk?.organizationId,
      projectId: state.projectId ?? latestOnDisk?.projectId,
      completedMilestones: state.completedMilestones.length > 0
        ? state.completedMilestones
        : (latestOnDisk?.completedMilestones ?? []),
      taskIds: state.taskIds.length > 0 ? state.taskIds : (latestOnDisk?.taskIds ?? []),
      artifactIds: state.artifactIds.length > 0 ? state.artifactIds : (latestOnDisk?.artifactIds ?? []),
    };

    // Extract error context
    let actionType: string | undefined;
    let principalId: string | undefined;
    let errRoute: string | undefined;
    let httpStatus: number | undefined;
    let responseBody: unknown;
    let responseText: string | undefined;

    if (err instanceof LiveActionError) {
      actionType = err.context.type;
      principalId = err.context.principalId;
      errRoute = err.context.route;
      httpStatus = err.context.httpStatus;
      responseBody = err.context.responseBody;
      responseText = err.context.responseText;
    } else if (err instanceof HttpResponseError) {
      errRoute = err.context.route;
      httpStatus = err.context.status;
      responseBody = err.context.responseBody;
      responseText = err.context.responseText;
    }

    const failure = normalizeFailure(err, {
      phase: state.lastPhase,
      actionType,
      principalId,
      route: errRoute,
      httpStatus,
      responseBody,
      responseText,
    });

    const failedState: LiveRunState = {
      ...merged,
      status: "failed",
      failure,
    };

    await saveLiveRunState(DATA_DIR, failedState);
    state = failedState;

    // Write failure reports
    failureReportPaths = await writeFailureReport(failedState, failure);
    console.log(`[e2e:live] failed. report=${failureReportPaths.reportPath}`);
    console.log(`[e2e:live] readable failure report=${failureReportPaths.readablePath}`);

    throw err;
  } finally {
    // Determine if keep-alive applies based on fixed semantics (Issue 7)
    const shouldKeepAlive = completed
      ? KEEP_ALIVE_ON_SUCCESS
      : KEEP_ALIVE_ON_FAILURE;

    if (shouldKeepAlive) {
      printKeepAliveInfo({
        state,
        reportPath: reportPath ?? failureReportPaths?.reportPath,
        contentReportPath: contentReportPath ?? failureReportPaths?.readablePath,
        consoleAvailable: Boolean(consoleProcess),
      });
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

  // ── Attach mode ──────────────────────────────────────────────────────────
  // Lumen E2E requires an existing human-guardian-created org/project.
  const existingOrganizationId = process.env.VIBLY_E2E_ORGANIZATION_ID;
  const existingProjectId = process.env.VIBLY_E2E_PROJECT_ID;
  const skipOrganizationCreate = process.env.VIBLY_E2E_SKIP_ORGANIZATION_CREATE === "true";

  const attachToExistingOrganization =
    IS_LUMEN_PROFILE || skipOrganizationCreate;

  if (attachToExistingOrganization) {
    if (!existingOrganizationId || !existingProjectId) {
      throw new Error(
        "Lumen VibMath E2E requires an existing human-guardian-created organization/project.\n" +
        "Set VIBLY_E2E_ORGANIZATION_ID and VIBLY_E2E_PROJECT_ID.\n" +
        "Create the organization/project from Console as a human Guardian first.",
      );
    }

    const bootstrapPrincipalId =
      process.env.VIBLY_E2E_BOOTSTRAP_PRINCIPAL_ID ??
      `principal_e2e_bootstrap_${sanitizeRunName(state.runName)}`;

    console.log(
      `[e2e:live] attaching run=${state.runName} org=${existingOrganizationId} project=${existingProjectId} actor=${bootstrapPrincipalId}`,
    );

    let next: LiveRunState = {
      ...state,
      // legacy field name; in attach mode this is the bootstrap action actor, not necessarily a human Guardian
      guardianPrincipalId: bootstrapPrincipalId,
      organizationId: existingOrganizationId,
      projectId: existingProjectId,
      status: "running" as const,
      lastPhase: "attach.resolve-existing-org-project",
    };
    await saveLiveRunState(DATA_DIR, next);
    next = await setPhase(next, "attach.register-agent-profiles");

    const agents = await loadYaml<{ agents: AgentConfig[] }>("agents.yaml");
    const mechanisms = await loadYaml<{ mechanisms: MechanismConfig[] }>("mechanisms.yaml");
    const knowledgeFiles = [
      "project-status.md",
      "goldbach-background.md",
      "known-problems.md",
      "existing-resources.md",
      "literature-index-empty.md",
      "research-method.md",
      "review-rubric.md",
      "failure-archive.md",
      "artifact-templates.md",
      "research-taxonomy.md",
    ];

    const chainSeedReceipts: Record<string, ChainSeedReceipt> = {};
    for (const agent of agents.agents) {
      const capabilities = [...new Set([...agent.roleHints, ...Object.keys(agent.skills)])];
      const reputationScore = agent.id === "lazy-agent" ? 0.1 : 0.75;
      const binding = await resolveChainBinding(agent, bootstrapPrincipalId);

      await action("RegisterAgentProfile", bootstrapPrincipalId, {
        principalId: agent.principalId,
        displayName: agent.id,
        organizationIds: [existingOrganizationId],
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

      await action("AddMember", bootstrapPrincipalId, {
        organizationId: existingOrganizationId,
        principalId: agent.principalId,
        role: agent.roleHints[0] ?? "agent",
      });

      if (binding.receipt) chainSeedReceipts[agent.id] = binding.receipt;
    }

    next = await setPhase(next, "attach.upsert-mechanism");
    for (const mechanism of mechanisms.mechanisms) {
      await action("UpsertMechanism", bootstrapPrincipalId, {
        ...mechanism,
        id: "mechanism_vibing_math_live",
        name: "vibing_math_live_llm_mechanism_v1",
        organizationId: existingOrganizationId,
        projectId: existingProjectId,
        timeout: { durationMs: 180_000, action: "select-backup" },
      });
    }
    next = await setPhase(next, "attach.seed-knowledge");
    for (const file of knowledgeFiles) {
      await action("SeedKnowledgeEntry", bootstrapPrincipalId, {
        organizationId: existingOrganizationId,
        projectId: existingProjectId,
        title: file,
        content: await readScenarioFile(`knowledge/${file}`),
        tags: ["initial", "goldbach", "live-llm"],
      });
    }

    console.log(
      `[e2e:live] attached run=${state.runName} org=${existingOrganizationId} project=${existingProjectId} chainSeed=${Object.keys(chainSeedReceipts).length}`,
    );
    return next;
  }

  // ── Auto-create mode (local/dev only) ────────────────────────────────────
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
    "research-method.md",
    "review-rubric.md",
    "failure-archive.md",
    "artifact-templates.md",
    "research-taxonomy.md",
  ];

  const orgName = process.env.VIBLY_E2E_ORG_NAME ?? (IS_LUMEN_PROFILE ? "Lumen VibMath" : "Live Vibing Math");
  const orgDescription =
    process.env.VIBLY_E2E_ORG_DESCRIPTION ??
    (IS_LUMEN_PROFILE
      ? "Lumen testnet VibMath live agent organization"
      : "Persistent live LLM multi-agent E2E organization");
  const projectName =
    process.env.VIBLY_E2E_PROJECT_NAME ??
    (IS_LUMEN_PROFILE ? "Lumen Goldbach Program" : "Live Goldbach Program");
  const projectSlugPrefix =
    process.env.VIBLY_E2E_PROJECT_SLUG_PREFIX ??
    (IS_LUMEN_PROFILE ? "lumen-goldbach" : "live-goldbach");

  // Use agent kind (not service) for the bootstrap actor
  const bootstrapPrincipal = await post("/principals", {
    kind: "agent",
    displayName: `e2e-bootstrap-${state.runName}`,
  }).then((body) => unwrapKey<Json>(body, "principal"));
  const bootstrapActor = String(bootstrapPrincipal.id);
  const orgId = await action("CreateOrganization", bootstrapActor, {
    name: orgName,
    description: orgDescription,
  }).then((result) => result.aggregateRef.id);
  await action("UpdateHandbook", bootstrapActor, {
    organizationId: orgId,
    handbook: {
      mission: orgHandbook,
      principles: [
        "Use ActionIntent for all state changes",
        "Build reusable research infrastructure before proof attempts",
      ],
      guardianPolicy: { guardian: bootstrapActor, powers: ["pause", "veto", "request_revision"] },
    },
  });
  const project = await post("/projects", {
    slug: `${projectSlugPrefix}-${state.runName}-${Date.now()}`,
    name: projectName,
    description: projectHandbook,
    sponsorPrincipalId: bootstrapActor,
    metadata: { organizationId: orgId, scenario: "live-llm-vibing-math", runName: state.runName },
  }).then((body) => unwrapKey<Json>(body, "project"));
  const projectId = String(project.id);

  const chainSeedReceipts: Record<string, ChainSeedReceipt> = {};
  for (const agent of agents.agents) {
    const capabilities = [...new Set([...agent.roleHints, ...Object.keys(agent.skills)])];
    const reputationScore = agent.id === "lazy-agent" ? 0.1 : 0.75;
    const binding = await resolveChainBinding(agent, bootstrapActor);

    await action("RegisterAgentProfile", bootstrapActor, {
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

    await action("AddMember", bootstrapActor, {
      organizationId: orgId,
      principalId: agent.principalId,
      role: agent.roleHints[0] ?? "agent",
    });

    if (binding.receipt) chainSeedReceipts[agent.id] = binding.receipt;
  }

  for (const mechanism of mechanisms.mechanisms) {
    await action("UpsertMechanism", bootstrapActor, {
      ...mechanism,
      id: "mechanism_vibing_math_live",
      name: "vibing_math_live_llm_mechanism_v1",
      organizationId: orgId,
      projectId,
      timeout: { durationMs: 180_000, action: "select-backup" },
    });
  }
  for (const file of knowledgeFiles) {
    await action("SeedKnowledgeEntry", bootstrapActor, {
      organizationId: orgId,
      projectId,
      title: file,
      content: await readScenarioFile(`knowledge/${file}`),
      tags: ["initial", "goldbach", "live-llm"],
    });
  }

  const next = {
    ...state,
    guardianPrincipalId: bootstrapActor,
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
    // If agent chain map already has both identityId and chainAgentId, skip seeding.
    const mapped = getAgentChainMap()[agent.id] ?? getAgentChainMap()[agent.principalId];
    if (mapped?.identityId && mapped?.chainAgentId) {
      console.log(`[e2e:live] Skipping chain seed for ${agent.id}: already mapped identityId=${mapped.identityId} chainAgentId=${mapped.chainAgentId}`);
      return mapped;
    }

    const chainRpcUrl =
      process.env.VIBLY_E2E_CHAIN_RPC_URL ??
      process.env.LUMEN_CHAIN_RPC_URL ??
      process.env.SUBSTRATE_RPC_URL;
    const graphqlUrl =
      process.env.VIBLY_E2E_INDEXER_URL ??
      process.env.LUMEN_INDEXER_GRAPHQL_URL ??
      process.env.SUBSTRATE_INDEXER_URL;
    if (!chainRpcUrl || !graphqlUrl) {
      throw new Error(
        "VIBLY_E2E_TESTNET_SEED=true requires VIBLY_E2E_CHAIN_RPC_URL/LUMEN_CHAIN_RPC_URL/SUBSTRATE_RPC_URL " +
        "and VIBLY_E2E_INDEXER_URL/LUMEN_INDEXER_GRAPHQL_URL/SUBSTRATE_INDEXER_URL.",
      );
    }
    const sharedIdentityId = mapped?.identityId ? mapped.identityId : getSharedIdentityId(agent);
    const receipt = await seedChainAgent({
      agentId: agent.id,
      coordinatorUrl: COORDINATOR_URL,
      apiToken: API_TOKEN,
      chainRpcUrl,
      graphqlUrl,
      chainId: CHAIN_ID,
      bondAmount: process.env.VIBLY_E2E_TESTNET_BOND_AMOUNT ?? "100",
      rootSignerUri: process.env.VIBLY_E2E_ROOT_SIGNER_URI,
      sharedIdentityId,
      registerIdentity: shouldRegisterIdentity(agent, sharedIdentityId),
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

function getSharedIdentityId(agent: AgentConfig): string | undefined {
  const mapped = getAgentChainMap()[agent.id] ?? getAgentChainMap()[agent.principalId];
  if (mapped?.identityId && !mapped.chainAgentId) return mapped.identityId;
  return process.env.VIBLY_E2E_SHARED_IDENTITY_ID;
}

function shouldRegisterIdentity(agent: AgentConfig, sharedIdentityId: string | undefined): boolean {
  if (sharedIdentityId) return false;
  return process.env.VIBLY_E2E_REGISTER_IDENTITY !== "false";
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

async function startAgentDaemons(agents: AgentConfig[], actorPrincipalId: string, organizationId: string, projectId: string): Promise<void> {
  const runName = sanitizeRunName(process.env.VIBLY_E2E_RUN_NAME ?? "live-vibing-math");
  const started: Array<{ agentId: string; child: ChildProcessWithoutNullStreams }> = [];
  for (const agent of agents) {
    const home = path.join(DATA_DIR, "live-runs", runName, "clients", agent.id);
    const binding = await resolveDaemonAgentBinding(agent, organizationId);
    await ensureDaemonStakeReady(agent, actorPrincipalId, binding);
    await mkdir(home, { recursive: true });
    await rm(path.join(home, "network-state.json"), { force: true });
    await writeFile(path.join(home, "config.json"), JSON.stringify({
      version: "0.1.0",
      defaultProfile: "default",
      profiles: {
        default: {
          name: "default",
          coordinatorUrl: COORDINATOR_URL,
          principalId: agent.principalId,
          agentId: agent.id,
          localAgentId: binding.localAgentId,
          identityId: binding.identityId,
          chainAgentId: binding.chainAgentId,
          organizationId: binding.organizationId,
          projectId,
          network: {
            id: CHAIN_ID,
            displayName: IS_LUMEN_PROFILE ? "Lumen" : "Local",
            label: IS_LUMEN_PROFILE ? "Lumen" : "Local",
            stage: IS_LUMEN_PROFILE || EXTERNAL_COORDINATOR ? "testnet" : "local",
            status: "active",
            coordinatorUrl: COORDINATOR_URL,
          },
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
        VIBLY_NETWORK_ID: CHAIN_ID,
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
    const stderrParts = failed.map((id) => {
      const agentId = id.split(" ")[0]!;
      return `--- ${agentId} stderr ---\n${tailStderr(`live-agent:${agentId}`)}`;
    });
    throw new Error(
      [
        `Live agent daemons exited before the run could continue: ${failed.join(", ")}.`,
        "Install vibly-client dependencies first: cd ../vibly-client && pnpm install",
        "",
        ...stderrParts,
      ].join("\n"),
    );
  }
}

async function resolveDaemonAgentBinding(agent: AgentConfig, organizationId: string): Promise<{
  localAgentId: string;
  identityId: string;
  chainAgentId: string;
  organizationId: string;
}> {
  const profile = await get<Json>(`/agent-profiles/${agent.principalId}`)
    .then((body) => unwrapKey<Json>(body, "agent"))
    .catch(() => undefined);
  const mapped = getAgentChainMap()[agent.id] ?? getAgentChainMap()[agent.principalId];
  const identityId = readOptionalString(profile?.identityId) ?? mapped?.identityId;
  const chainAgentId = readOptionalString(profile?.chainAgentId) ?? mapped?.chainAgentId;
  if (!identityId || !chainAgentId) {
    throw new Error(
      `Agent ${agent.id} is missing daemon chain binding. ` +
      `Expected identityId and chainAgentId on /agent-profiles/${agent.principalId} or VIBLY_E2E_AGENT_CHAIN_MAP.`,
    );
  }
  return {
    localAgentId: readOptionalString(profile?.localAgentId) ?? agent.id,
    identityId,
    chainAgentId,
    organizationId: readOptionalString(profile?.organizationId) ?? organizationId,
  };
}

async function ensureDaemonStakeReady(
  agent: AgentConfig,
  actorPrincipalId: string,
  binding: { identityId: string; chainAgentId: string },
): Promise<void> {
  // When USE_REAL_STAKE is false (mock mode), write the stake ledger directly.
  if (!USE_REAL_STAKE) {
    await action("UpsertAgentStakeLedger", actorPrincipalId, {
      chainId: CHAIN_ID,
      identityId: binding.identityId,
      chainAgentId: binding.chainAgentId,
      principalId: agent.principalId,
      fundingAccount: `${agent.id}_funding`,
      activeAmount: "100",
      unbondingAmount: "0",
      status: "active",
      releaseBlocked: false,
      updatedAtBlock: "1",
    });
    return;
  }

  // When using real stake, first wait for the coordinator to sync from chain.
  // If the coordinator's AGENT_STAKE_SYNC_INTERVAL_MS is 0 (default) the sync
  // never runs, so fall back to writing the stake ledger directly.
  try {
    await waitForCoordinatorStakeSync(COORDINATOR_URL, API_TOKEN, agent.principalId, 120_000);
  } catch {
    console.warn(`[e2e:live] coordinator stake sync timed out for ${agent.principalId}, writing stake ledger directly`);
    await action("UpsertAgentStakeLedger", actorPrincipalId, {
      chainId: CHAIN_ID,
      identityId: binding.identityId,
      chainAgentId: binding.chainAgentId,
      principalId: agent.principalId,
      fundingAccount: `${agent.id}_funding`,
      activeAmount: "100",
      unbondingAmount: "0",
      status: "active",
      releaseBlocked: false,
      updatedAtBlock: "1",
    });
  }
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

// ── Coordinator request helpers ──────────────────────────────────────────

function coordinatorHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${API_TOKEN}`,
    "x-vibly-client-version": E2E_CLIENT_VERSION,
    "x-vibly-contract-version": E2E_CONTRACT_VERSION,
    "x-vibly-protocol-version": E2E_PROTOCOL_VERSION,
    "x-vibly-client-package": E2E_CLIENT_PACKAGE,
    ...extra,
  };
}

async function action(type: string, principalId: string, payload: Json): Promise<{ aggregateRef: { id: string; kind: string } }> {
  // Save lastAction for failure context before making the request
  const startedAt = new Date().toISOString();
  try {
    const body = await post("/action-intents", { type, principalId, payload });
    return unwrapData<{ aggregateRef: { id: string; kind: string } }>(body);
  } catch (err) {
    // Wrap non-LiveActionError errors with action context
    if (!(err instanceof LiveActionError) && !(err instanceof HttpResponseError)) {
      throw new LiveActionError(
        `ActionIntent failed: type=${type} principal=${principalId} status=error route=/action-intents`,
        { type, principalId, route: "/action-intents" },
        { cause: err },
      );
    }
    throw err;
  }
}

async function post(route: string, body: Json): Promise<Json> {
  const response = await fetch(`${COORDINATOR_URL}${route}`, {
    method: "POST",
    headers: coordinatorHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return parseResponse(route, response, "POST");
}

async function get<T extends Json = Json>(route: string, query?: Record<string, string | number>): Promise<T> {
  const url = new URL(`${COORDINATOR_URL}${route}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: coordinatorHeaders() });
  return parseResponse(route, response, "GET") as Promise<T>;
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

async function parseResponse(route: string, response: Response, method?: string): Promise<Json> {
  const text = await response.text();
  let body: Json | undefined;
  try {
    body = text ? JSON.parse(text) as Json : {};
  } catch {
    body = undefined;
  }

  if (!response.ok || body?.ok === false) {
    throw new HttpResponseError({
      route,
      method: method ?? "UNKNOWN",
      status: response.status,
      statusText: response.statusText,
      responseBody: body,
      responseText: body ? undefined : text,
    });
  }

  return body ?? {};
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

// ── Child process log rings (Issue 8) ────────────────────────────────────

const LOG_RING_MAX_LINES = 200;

interface LogRing {
  name: string;
  stdout: string[];
  stderr: string[];
}

const logRings = new Map<string, LogRing>();

function getLogRing(name: string): LogRing {
  let ring = logRings.get(name);
  if (!ring) {
    ring = { name, stdout: [], stderr: [] };
    logRings.set(name, ring);
  }
  return ring;
}

function appendToRing(lines: string[], ring: string[], max: number): void {
  for (const line of lines) {
    ring.push(line);
    if (ring.length > max) ring.shift();
  }
}

function tailStderr(name: string, n = 30): string {
  const ring = logRings.get(name);
  if (!ring || ring.stderr.length === 0) return "(no stderr)";
  return ring.stderr.slice(-n).join("\n");
}

function dumpAllStderr(): string {
  const parts: string[] = [];
  for (const [name, ring] of logRings) {
    if (ring.stderr.length > 0) {
      parts.push(`--- ${name} stderr tail ---`);
      parts.push(tailStderr(name, 50));
    }
  }
  return parts.join("\n");
}

let pipeLogDir: string | undefined;

function setPipeLogDir(dir: string): void {
  pipeLogDir = dir;
}

async function writeLogLine(kind: "stdout" | "stderr", name: string, line: string): Promise<void> {
  if (!pipeLogDir) return;
  const file = path.join(pipeLogDir, `logs`, `${name}.${kind}.log`);
  try {
    await appendFile(file, line + "\n", "utf8");
  } catch {
    // best effort
  }
}

function pipeChild(name: string, child: ChildProcessWithoutNullStreams): void {
  const ring = getLogRing(name);
  child.stdout.on("data", (chunk: Buffer) => {
    const text = String(chunk);
    const lines = text.split("\n").filter(Boolean);
    appendToRing(lines, ring.stdout, LOG_RING_MAX_LINES);
    for (const line of lines) {
      void writeLogLine("stdout", name, line);
    }
    if (process.env.VIBLY_E2E_VERBOSE === "true") process.stdout.write(`[${name}] ${text}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const text = String(chunk);
    const lines = text.split("\n").filter(Boolean);
    appendToRing(lines, ring.stderr, LOG_RING_MAX_LINES);
    for (const line of lines) {
      void writeLogLine("stderr", name, line);
    }
    if (process.env.VIBLY_E2E_VERBOSE === "true") process.stderr.write(`[${name}] ${text}`);
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
  if (IS_LUMEN_PROFILE) {
    return `lumen-vibmath-${stamp}`;
  }
  return `live-vibing-math-${stamp}`;
}

// ── Phase tracking (Issue 3) ─────────────────────────────────────────────

async function setPhase(state: LiveRunState, phase: string): Promise<LiveRunState> {
  const next = { ...state, lastPhase: phase };
  await saveLiveRunState(DATA_DIR, next);
  console.log(`[e2e:live] phase=${phase}`);
  return next;
}

// ── Failure helpers (Issues 1, 6) ────────────────────────────────────────

function normalizeFailure(
  err: unknown,
  context?: { phase?: string; actionType?: string; principalId?: string; route?: string; method?: string; httpStatus?: number; responseBody?: unknown; responseText?: string },
): LiveRunFailure {
  const occurredAt = new Date().toISOString();
  if (err instanceof LiveActionError) {
    return {
      phase: context?.phase,
      actionType: err.context.type,
      principalId: err.context.principalId,
      route: err.context.route,
      httpStatus: err.context.httpStatus,
      responseBody: err.context.responseBody,
      responseText: err.context.responseText,
      message: err.message,
      stack: err.stack,
      causedBy: err.cause,
      occurredAt,
    };
  }
  if (err instanceof HttpResponseError) {
    return {
      phase: context?.phase,
      route: err.context.route,
      method: err.context.method,
      httpStatus: err.context.status,
      responseBody: err.context.responseBody,
      responseText: err.context.responseText,
      message: err.message,
      stack: err.stack,
      causedBy: err.cause,
      occurredAt,
    };
  }
  return {
    phase: context?.phase,
    actionType: context?.actionType,
    principalId: context?.principalId,
    route: context?.route,
    httpStatus: context?.httpStatus,
    responseBody: context?.responseBody,
    responseText: context?.responseText,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    causedBy: err instanceof Error ? err.cause : undefined,
    occurredAt,
  };
}

function buildFailureReportPath(runName: string, suffix: string): string {
  return path.join(REPORT_DIR, `live-llm-failure-${runName}-${Date.now()}.${suffix}`);
}

async function writeFailureReport(
  state: LiveRunState,
  failure: LiveRunFailure,
): Promise<{ reportPath: string; readablePath: string }> {
  const reportPath = buildFailureReportPath(state.runName, "json");
  const readablePath = buildFailureReportPath(state.runName, "md");

  const report = {
    runName: state.runName,
    status: "failed",
    coordinatorUrl: COORDINATOR_URL,
    organizationId: state.organizationId,
    projectId: state.projectId,
    guardianPrincipalId: state.guardianPrincipalId,
    lastPhase: state.lastPhase,
    lastAction: state.lastAction,
    failure: {
      message: failure.message,
      phase: failure.phase,
      actionType: failure.actionType,
      principalId: failure.principalId,
      route: failure.route,
      method: failure.method,
      httpStatus: failure.httpStatus,
      // Only include safe fields — no secrets
      responseBody: failure.responseBody,
    },
  };

  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

  const md = [
    `# Live LLM VibMath Failure Report`,
    ``,
    `- Run: ${state.runName}`,
    `- Phase: ${failure.phase ?? "unknown"}`,
    `- Action: ${failure.actionType ?? "N/A"}`,
    `- Principal: ${failure.principalId ?? "N/A"}`,
    failure.httpStatus ? `- HTTP: ${failure.httpStatus}` : null,
    `- Coordinator: ${COORDINATOR_URL}`,
    ``,
    `## Message`,
    ``,
    failure.message,
    ``,
    failure.responseBody ? [
      `## Response`,
      ``,
      "```json",
      JSON.stringify(failure.responseBody, null, 2),
      "```",
    ].join("\n") : null,
    ``,
    failure.responseText ? [
      `## Response Text`,
      ``,
      "```",
      failure.responseText,
      "```",
    ].join("\n") : null,
    ``,
    `## State Snapshot`,
    ``,
    "```json",
    JSON.stringify({
      runName: state.runName,
      status: state.status,
      lastPhase: state.lastPhase,
      lastAction: state.lastAction,
      organizationId: state.organizationId,
      projectId: state.projectId,
      guardianPrincipalId: state.guardianPrincipalId,
      completedMilestones: state.completedMilestones,
    }, null, 2),
    "```",
    ``,
  ].filter(Boolean).join("\n");

  await writeFile(readablePath, md);
  return { reportPath, readablePath };
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
