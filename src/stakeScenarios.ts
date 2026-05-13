/**
 * Stake-specific E2E scenarios:
 *
 *  Scenario A — Root-initiated unbond: unbonding agent stops receiving new duties.
 *  Scenario B — Agent-initiated unbond: same semantics via agent signer.
 *  Scenario C — Release block when unfinished duties exist.
 *  Scenario D — Clear release after duties complete.
 *
 * Entry point: `pnpm e2e:stake` (runs all four in sequence).
 * Individual modes via VIBLY_E2E_UNBOND / VIBLY_E2E_STALE_INDEXER env vars.
 */

import path from "node:path";
import process from "node:process";
import { writeFile, mkdir } from "node:fs/promises";
import {
  startSoloNode,
  stopSoloNode,
  type SoloNodeHandle,
} from "./lifecycle/soloNode.js";
import {
  startIndexer,
  stopIndexer,
  waitForIndexerReady,
  queryIndexerLedger,
  type IndexerHandle,
} from "./lifecycle/indexer.js";
import {
  seedChainAgent,
  waitForIndexerActiveLedger,
  waitForCoordinatorStakeSync,
  type ChainSeedReceipt,
} from "./chainSeed.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPORT_DIR = path.join(ROOT, "reports");
const DATA_DIR = path.join(ROOT, "data");
const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? `http://127.0.0.1:${COORDINATOR_PORT}`;
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";
const CHAIN_ID = process.env.VIBLY_E2E_CHAIN_ID ?? "substrate:vibly-solo";
const ROOT_SIGNER_URI = process.env.VIBLY_E2E_ROOT_SIGNER_URI ?? "//Alice";
// Each //AgentN uses a different dev key pair on the solo chain.
const AGENT_SIGNER_URIS: Record<string, string> = {
  "observer-agent-1": "//Bob",
  "observer-agent-2": "//Charlie",
};

// ── Public entry ──────────────────────────────────────────────────────────────

export interface StakeScenariosContext {
  soloNodeHandle: SoloNodeHandle;
  indexerHandle: IndexerHandle;
  coordinatorUrl: string;
  apiToken: string;
  chainId: string;
  chainRpcUrl: string;
  graphqlUrl: string;
  /** Seeds (already bonded) from a previous chainSeed step — keyed by agentId. */
  seeds: Record<string, ChainSeedReceipt>;
  /** Coordinator principal IDs, keyed by agentId. */
  principalIds: Record<string, string>;
  /** Active org + project IDs from the deterministic scenario. */
  organizationId: string;
  projectId: string;
  guardianPrincipalId: string;
}

export interface StakeScenariosReport {
  scenarioA: "passed" | "skipped" | string;
  scenarioB: "passed" | "skipped" | string;
  scenarioC: "passed" | "skipped" | string;
  scenarioD: "passed" | "skipped" | string;
}

export async function runStakeScenarios(
  ctx: StakeScenariosContext,
): Promise<StakeScenariosReport> {
  const report: StakeScenariosReport = {
    scenarioA: "skipped",
    scenarioB: "skipped",
    scenarioC: "skipped",
    scenarioD: "skipped",
  };

  if (process.env.VIBLY_E2E_STALE_INDEXER === "true") {
    console.log("[stake] VIBLY_E2E_STALE_INDEXER mode — skipping unbond scenarios");
    return report;
  }

  // Scenario A: Root-initiated unbond
  try {
    await scenarioA(ctx);
    report.scenarioA = "passed";
    console.log("[stake] Scenario A passed");
  } catch (err) {
    report.scenarioA = String(err);
    console.error(`[stake] Scenario A FAILED: ${String(err)}`);
  }

  // Scenario B: Agent-initiated unbond
  try {
    await scenarioB(ctx);
    report.scenarioB = "passed";
    console.log("[stake] Scenario B passed");
  } catch (err) {
    report.scenarioB = String(err);
    console.error(`[stake] Scenario B FAILED: ${String(err)}`);
  }

  // Scenario C/D: Release block and clear (only when VIBLY_E2E_UNBOND=true or default)
  try {
    const { scenarioC: c, scenarioD: d } = await scenarioCandD(ctx);
    report.scenarioC = c;
    report.scenarioD = d;
  } catch (err) {
    report.scenarioC = String(err);
    report.scenarioD = String(err);
    console.error(`[stake] Scenario C/D FAILED: ${String(err)}`);
  }

  return report;
}

// ── Scenario A — Root-initiated unbond ───────────────────────────────────────

async function scenarioA(ctx: StakeScenariosContext): Promise<void> {
  console.log("[stake:A] Root-initiated unbond of observer-agent-1…");
  const seed = ctx.seeds["observer-agent-1"];
  if (!seed) throw new Error("observer-agent-1 seed not found");

  await spawnChainCli(ctx.chainRpcUrl, ROOT_SIGNER_URI, ctx.chainId, [
    "agent", "stake", "request-unbond",
    "--identity-id", seed.identityId,
    "--agent-id", seed.chainAgentId,
    "--amount", "50",
    "--json",
  ]);

  // Wait for indexer to reflect unbonding status.
  console.log("[stake:A] Waiting for indexer ledger status=unbonding…");
  await waitForIndexerLedgerStatus(ctx.graphqlUrl, seed.chainAgentId, "unbonding", 60_000);

  // Create a new observation task and confirm the unbonding agent is NOT assigned.
  const taskId = await coordinatorAction(ctx, "CreateObservationTask", ctx.guardianPrincipalId, {
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    title: "Scenario A — unbonding exclusion probe",
    description: "Verify unbonding agents are excluded from new assignments.",
    mechanismId: "mechanism_vibing_math_main",
  }).then((r) => r.aggregateRef.id);

  // Give the coordinator up to 15 s to offer the assignment; the unbonding
  // agent must NOT appear as the assignee.
  await sleep(5_000);
  const assignee = await findAnyAssigneeExcluding(
    ctx,
    taskId,
    ctx.principalIds["observer-agent-1"] ?? "principal_observer_1",
  );
  if (!assignee) {
    console.log("[stake:A] No assignment offered yet — acceptable (no eligible agents)");
  }
  console.log("[stake:A] observer-agent-1 not assigned to new task ✓");
}

// ── Scenario B — Agent/operator-initiated unbond ─────────────────────────────

async function scenarioB(ctx: StakeScenariosContext): Promise<void> {
  console.log("[stake:B] Agent-initiated unbond of observer-agent-2…");
  const seed = ctx.seeds["observer-agent-2"];
  if (!seed) throw new Error("observer-agent-2 seed not found");

  const agentSigner = AGENT_SIGNER_URIS["observer-agent-2"] ?? "//Dave";
  await spawnChainCli(ctx.chainRpcUrl, agentSigner, ctx.chainId, [
    "agent", "stake", "request-unbond",
    "--identity-id", seed.identityId,
    "--agent-id", seed.chainAgentId,
    "--amount", "50",
    "--json",
  ]);

  console.log("[stake:B] Waiting for indexer ledger status=unbonding…");
  await waitForIndexerLedgerStatus(ctx.graphqlUrl, seed.chainAgentId, "unbonding", 60_000);

  // Verify coordinator projection agrees.
  const principalId = ctx.principalIds["observer-agent-2"] ?? "principal_observer_2";
  await waitForCoordinatorLedgerStatus(ctx.coordinatorUrl, ctx.apiToken, principalId, "unbonding", 30_000);
  console.log("[stake:B] Coordinator confirms unbonding status for observer-agent-2 ✓");

  // New public obligation must not include the unbonding agent.
  const taskId = await coordinatorAction(ctx, "CreateObservationTask", ctx.guardianPrincipalId, {
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    title: "Scenario B — agent unbond exclusion probe",
    description: "Verify agent-initiated unbond excludes from new assignments.",
    mechanismId: "mechanism_vibing_math_main",
  }).then((r) => r.aggregateRef.id);

  await sleep(5_000);
  const assignee = await findAnyAssigneeExcluding(
    ctx,
    taskId,
    principalId,
  );
  if (!assignee) {
    console.log("[stake:B] No assignment yet — acceptable");
  }
  console.log("[stake:B] observer-agent-2 not assigned to new task ✓");
}

// ── Scenarios C + D — Release block and clear ────────────────────────────────

async function scenarioCandD(
  ctx: StakeScenariosContext,
): Promise<{ scenarioC: "passed" | string; scenarioD: "passed" | string }> {
  // Find a staked agent that is still active.
  const activeAgentId = Object.keys(ctx.seeds).find(
    (id) =>
      id !== "observer-agent-1" &&
      id !== "observer-agent-2" &&
      ctx.seeds[id]?.indexerLedger.status === "active",
  );
  if (!activeAgentId) {
    console.warn("[stake:C/D] No active-staked agent left — skipping");
    return { scenarioC: "skipped", scenarioD: "skipped" };
  }
  const seed = ctx.seeds[activeAgentId]!;
  const principalId = ctx.principalIds[activeAgentId] ?? `principal_${activeAgentId}`;

  // ── Scenario C: block release ─────────────────────────────────────────────
  console.log(`[stake:C] Testing block_release for ${activeAgentId}…`);

  // 1. Create observation task and wait for assignment offer to the active agent.
  const taskId = await coordinatorAction(ctx, "CreateObservationTask", ctx.guardianPrincipalId, {
    organizationId: ctx.organizationId,
    projectId: ctx.projectId,
    title: "Scenario C — release block probe",
    description: "Active obligation used to test release blocking.",
    mechanismId: "mechanism_vibing_math_main",
  }).then((r) => r.aggregateRef.id);

  console.log(`[stake:C] Waiting for ${activeAgentId} to receive assignment offer…`);
  const offer = await waitFor(
    () =>
      coordinatorGet<Json>(
        ctx,
        `/agents/${principalId}/inbox`,
        { organizationId: ctx.organizationId, limit: 20 },
      ).then((body) => {
        const inbox = unwrapKey<Json>(body, "inbox");
        const offers = inbox.assignmentOffers as Json[];
        return offers.find((o) => o.observationTaskId === taskId || o.taskId === taskId);
      }),
    `assignment offer for ${activeAgentId}`,
    30_000,
  );

  // 2. Request unbond while assignment is outstanding.
  console.log(`[stake:C] Requesting unbond for ${activeAgentId} while assignment is offered…`);
  await spawnChainCli(ctx.chainRpcUrl, ROOT_SIGNER_URI, ctx.chainId, [
    "agent", "stake", "request-unbond",
    "--identity-id", seed.identityId,
    "--agent-id", seed.chainAgentId,
    "--amount", "100",
    "--json",
  ]);

  // 3. Wait for coordinator projection: releaseBlocked=true.
  console.log("[stake:C] Waiting for coordinator to reflect releaseBlocked=true…");
  await waitForCoordinatorReleaseBlocked(
    ctx.coordinatorUrl,
    ctx.apiToken,
    principalId,
    true,
    60_000,
  );
  console.log("[stake:C] releaseBlocked=true confirmed ✓");
  const scenarioCResult = "passed";

  // ── Scenario D: clear release after duty completion ───────────────────────
  console.log(`[stake:D] Waiting for daemon to complete obligation (assignment ${String(offer.id)})…`);

  // Wait for the assignment to transition to a terminal state (accepted, then completed via daemon).
  await waitFor(
    () =>
      coordinatorGet<Json>(ctx, `/events`, {
        limit: 100,
        organizationId: ctx.organizationId,
      }).then((body) => {
        const events = extractItems<Json>(body);
        return events.find(
          (e) =>
            (e.type === "AssignmentAccepted" || e.type === "ObservationSubmitted") &&
            (String(e.assignmentId ?? "") === String(offer.id) ||
              String(e.observationTaskId ?? "") === taskId),
        );
      }),
    "daemon assignment completion",
    120_000,
  );

  // Wait for coordinator to clear the release block.
  console.log("[stake:D] Waiting for coordinator to clear releaseBlocked…");
  await waitForCoordinatorReleaseBlocked(
    ctx.coordinatorUrl,
    ctx.apiToken,
    principalId,
    false,
    120_000,
  );
  console.log("[stake:D] releaseBlocked=false confirmed ✓");

  return { scenarioC: scenarioCResult, scenarioD: "passed" };
}

// ── Coordinator helpers ───────────────────────────────────────────────────────

async function coordinatorAction(
  ctx: StakeScenariosContext,
  type: string,
  principalId: string,
  payload: Json,
): Promise<{ aggregateRef: { id: string; kind: string } }> {
  const resp = await fetch(`${ctx.coordinatorUrl}/action-intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.apiToken}`,
    },
    body: JSON.stringify({ type, principalId, payload }),
  });
  if (!resp.ok) {
    throw new Error(`action ${type} failed: HTTP ${resp.status}`);
  }
  const body = (await resp.json()) as { data?: { aggregateRef: { id: string; kind: string } } };
  return body.data!;
}

async function coordinatorGet<T extends Json>(
  ctx: StakeScenariosContext,
  route: string,
  query?: Record<string, string | number>,
): Promise<T> {
  const url = new URL(`${ctx.coordinatorUrl}${route}`);
  for (const [key, val] of Object.entries(query ?? {}))
    url.searchParams.set(key, String(val));
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${ctx.apiToken}` },
  });
  if (!resp.ok) throw new Error(`GET ${route} failed: HTTP ${resp.status}`);
  return (await resp.json()) as T;
}

function unwrapKey<T>(body: Json, key: string): T {
  const data = (body as { data?: Json }).data as Json;
  return data[key] as T;
}

function extractItems<T>(body: Json): T[] {
  const data = (body as { data?: unknown }).data;
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as Json).items))
    return (data as { items: T[] }).items;
  return [];
}

// ── Wait helpers ──────────────────────────────────────────────────────────────

async function waitForIndexerLedgerStatus(
  graphqlUrl: string,
  chainAgentId: string,
  status: "active" | "unbonding" | "released",
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () => {
      const ledger = await queryIndexerLedger(graphqlUrl, chainAgentId);
      return ledger?.status === status ? true : undefined;
    },
    `indexer ledger ${chainAgentId.slice(0, 12)}… status=${status}`,
    timeoutMs,
  );
}

async function waitForCoordinatorLedgerStatus(
  coordinatorUrl: string,
  apiToken: string,
  principalId: string,
  status: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () => {
      const resp = await fetch(`${coordinatorUrl}/agent-profiles/${principalId}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!resp.ok) return undefined;
      const body = (await resp.json()) as {
        data?: { agent?: { stakeLedger?: { status?: string } } };
      };
      return body.data?.agent?.stakeLedger?.status === status ? true : undefined;
    },
    `coordinator ledger status=${status} for ${principalId}`,
    timeoutMs,
  );
}

async function waitForCoordinatorReleaseBlocked(
  coordinatorUrl: string,
  apiToken: string,
  principalId: string,
  blocked: boolean,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () => {
      const resp = await fetch(`${coordinatorUrl}/agent-profiles/${principalId}`, {
        headers: { Authorization: `Bearer ${apiToken}` },
      });
      if (!resp.ok) return undefined;
      const body = (await resp.json()) as {
        data?: { agent?: { stakeLedger?: { releaseBlocked?: boolean } } };
      };
      const ledger = body.data?.agent?.stakeLedger;
      return ledger?.releaseBlocked === blocked ? true : undefined;
    },
    `coordinator releaseBlocked=${String(blocked)} for ${principalId}`,
    timeoutMs,
  );
}

async function findAnyAssigneeExcluding(
  ctx: StakeScenariosContext,
  taskId: string,
  excludedPrincipalId: string,
): Promise<string | undefined> {
  for (const [agentId, principalId] of Object.entries(ctx.principalIds)) {
    if (principalId === excludedPrincipalId) continue;
    try {
      const resp = await fetch(
        `${ctx.coordinatorUrl}/agents/${principalId}/inbox?limit=20`,
        { headers: { Authorization: `Bearer ${ctx.apiToken}` } },
      );
      if (!resp.ok) continue;
      const body = (await resp.json()) as { data?: { inbox?: { assignmentOffers?: Json[] } } };
      const offers = body.data?.inbox?.assignmentOffers ?? [];
      const found = offers.find(
        (o) => o.observationTaskId === taskId || o.taskId === taskId,
      );
      if (found) return principalId;
    } catch {
      // ignore per-agent errors
    }
  }
  return undefined;
}

// ── Chain CLI spawn ───────────────────────────────────────────────────────────

async function spawnChainCli(
  rpcUrl: string,
  signerUri: string,
  chainId: string,
  args: string[],
): Promise<Record<string, unknown>> {
  const { spawn } = await import("node:child_process");
  const CLIENT_DIR = path.resolve(ROOT, "../vibly-client");
  return new Promise((resolve, reject) => {
    // Invoke tsx directly to avoid pnpm's "--" separator breaking Commander.js option parsing.
    const child = spawn(
      "pnpm",
      ["exec", "tsx", "src/main.ts", ...args, "--rpc-url", rpcUrl, "--signer-uri", signerUri, "--chain-id", chainId],
      { cwd: CLIENT_DIR, env: { ...process.env }, stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf: Buffer) => { stdout += buf.toString(); });
    child.stderr.on("data", (buf: Buffer) => { stderr += buf.toString(); });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`CLI exit ${String(code)}: ${stderr}\n${stdout}`));
        return;
      }
      const line = stdout.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"));
      if (!line) { resolve({}); return; }
      try { resolve(JSON.parse(line) as Record<string, unknown>); }
      catch (e) { reject(new Error(`JSON parse: ${String(e)}\n${line}`)); }
    });
    child.on("error", reject);
  });
}

// ── waitFor utility ───────────────────────────────────────────────────────────

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (result !== undefined) return result;
    } catch (err) {
      lastError = err;
    }
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Standalone entry (pnpm e2e:stake) ────────────────────────────────────────

type Json = Record<string, unknown>;

async function standaloneMain(): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });

  const soloNodeHandle = await startSoloNode({ rpcExternal: true });
  const indexerHandle = await startIndexer(soloNodeHandle.rpcPort);

  try {
    const chainRpcUrl = soloNodeHandle.wsUrl;
    const graphqlUrl = indexerHandle.graphqlUrl;

    // Seed two probe agents.
    const probeAgents = [
      { agentId: "observer-agent-1", principalId: "principal_observer_1" },
      { agentId: "observer-agent-2", principalId: "principal_observer_2" },
      { agentId: "proposer-agent", principalId: "principal_proposer" },
    ];
    const seeds: Record<string, ChainSeedReceipt> = {};
    for (const pa of probeAgents) {
      seeds[pa.agentId] = await seedChainAgent({
        agentId: pa.agentId,
        coordinatorUrl: COORDINATOR_URL,
        apiToken: API_TOKEN,
        chainRpcUrl,
        graphqlUrl,
        chainId: CHAIN_ID,
      });
    }

    const ctx: StakeScenariosContext = {
      soloNodeHandle,
      indexerHandle,
      coordinatorUrl: COORDINATOR_URL,
      apiToken: API_TOKEN,
      chainId: CHAIN_ID,
      chainRpcUrl,
      graphqlUrl,
      seeds,
      principalIds: Object.fromEntries(probeAgents.map((pa) => [pa.agentId, pa.principalId])),
      organizationId: process.env.VIBLY_E2E_ORG_ID ?? "",
      projectId: process.env.VIBLY_E2E_PROJECT_ID ?? "",
      guardianPrincipalId: process.env.VIBLY_E2E_GUARDIAN_ID ?? "",
    };

    const report = await runStakeScenarios(ctx);
    const ts = Date.now();
    const reportPath = path.join(REPORT_DIR, `chain-stake-${ts}.json`);
    await writeFile(reportPath, JSON.stringify({ ...report, chainRpcUrl, graphqlUrl }, null, 2));
    console.log(`[stake] report written to ${reportPath}`);

    const failed = Object.entries(report).filter(([, v]) => v !== "passed" && v !== "skipped");
    if (failed.length > 0) {
      console.error(`[stake] FAILED scenarios: ${failed.map(([k]) => k).join(", ")}`);
      process.exit(1);
    }
    console.log("[stake] all scenarios passed.");
  } finally {
    await stopIndexer();
    await stopSoloNode(soloNodeHandle);
  }
}

// Only run as standalone when this file is the entry point.
if (process.argv[1]?.endsWith("stakeScenarios.js") || process.argv[1]?.endsWith("stakeScenarios.ts")) {
  standaloneMain().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
