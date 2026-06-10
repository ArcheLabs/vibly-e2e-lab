/**
 * Lumen preflight checks.
 *
 * Validates that the local identity cache exists, chain state is consistent,
 * and the funding address has sufficient balance before the bootstrap script
 * starts agents.
 */

import path from "node:path";
import process from "node:process";
import {
  loadIdentityPrivate,
  loadIdentityPublic,
  saveIdentityPublic,
  defaultLumenCacheDir,
  computeAgentRef,
  identityPublicPath,
  identityPrivatePath,
  type LumenIdentityPrivate,
} from "./lumenIdentityCache.js";
import {
  loadAgentsPrivate,
  saveAgentsPrivate,
  saveAgentsPublic,
  type LumenAgentsPrivate,
  type LumenAgentsPublic,
  type CachedAgentPrivate,
  type CachedAgentPublic,
} from "./lumenAgentCache.js";
import {
  syncLumenChainState,
  computeLumenDiff,
  printLumenDiff,
  saveLastDiff,
  saveChainCache,
} from "./lumenChainSync.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const SCENARIO = path.resolve(import.meta.dirname, "..", "scenarios", "vibing-math");

// ── Main preflight entry ──────────────────────────────────────────────────────

export interface PreflightResult {
  ok: boolean;
  identity: LumenIdentityPrivate;
  agents: LumenAgentsPrivate;
  cacheDir: string;
}

/**
 * Run the full Lumen preflight check.
 *
 * 1. Load identity cache (throws if not found).
 * 2. Sync chain state.
 * 3. Compare local vs chain.
 * 4. Print and persist diff if any.
 * 5. Check funding balance.
 * 6. Prepare missing local agents.
 *
 * Returns the loaded identity and agents if all checks pass.
 */
export async function runLumenPreflight(): Promise<PreflightResult> {
  const cacheDir = defaultLumenCacheDir();

  // ── 1. Load identity cache ────────────────────────────────────────────────
  const identity = await loadIdentityPrivate(cacheDir);
  if (!identity) {
    console.error("");
    console.error("Lumen identity cache was not found.");
    console.error("");
    console.error("Run:");
    console.error("  pnpm e2e:vibmath:lumen:identity:init");
    console.error("");
    throw new Error("Lumen identity cache not found. Run identity:init first.");
  }

  if (!identity.identity.identityId) {
    console.error("");
    console.error("Lumen identity is not yet registered on chain.");
    console.error(`Status: ${identity.identity.status ?? "pending_funding"}`);
    console.error("Funding address:", identity.identity.publicAddress);
    console.error("");
    console.error("Send enough VIB to the funding address, then re-run:");
    console.error("  pnpm e2e:vibmath:lumen:preflight");
    console.error("");
    console.error("If the identity was already funded, run identity:init again to register it on chain:");
    console.error("  pnpm e2e:vibmath:lumen:identity:init");
    console.error("");
    throw new Error("Lumen identity not yet registered on chain.");
  }

  // ── 2. Load agent cache ──────────────────────────────────────────────────
  let agents = await loadAgentsPrivate(cacheDir);
  if (!agents) {
    agents = {
      version: 1,
      profile: "lumen",
      network: "lumen",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      agents: [],
    };
  }

  // ── 3. Sync chain state ──────────────────────────────────────────────────
  const chainRpcUrl = resolveChainRpcUrl();
  const graphqlUrl = resolveGraphqlUrl();
  const coordinatorUrl = resolveCoordinatorUrl();

  console.log(`[lumen:preflight] Syncing chain state from ${chainRpcUrl}…`);
  const chainState = await syncLumenChainState(chainRpcUrl, graphqlUrl, identity, agents);
  await saveChainCache(cacheDir, chainState);

  // ── 4. Compare local vs chain ────────────────────────────────────────────
  const diff = computeLumenDiff(identity, agents, chainState);
  await saveLastDiff(cacheDir, diff);
  printLumenDiff(diff);

  if (diff.summary.severity === "blocking") {
    console.error("");
    console.error("Chain state contains identity/agents that are missing from local cache.");
    console.error("");
    console.error(`Diff written to: ${path.join(cacheDir, "last-diff.json")}`);
    console.error("");
    console.error("Resolve the cache mismatch before starting agents.");
    console.error("");
    throw new Error("Blocking diff between local cache and chain state.");
  }

  // ── 5. Check funding balance ─────────────────────────────────────────────
  const balance = BigInt(chainState.identity.freeBalance);
  const required = await calculateRequiredBalance(agents);
  if (balance < required) {
    console.error("");
    console.error("Lumen funding balance is not enough.");
    console.error("");
    console.error(`Funding address: ${identity.identity.publicAddress}`);
    console.error(`Current free balance: ${balance.toString()}`);
    console.error(`Required minimum: ${required.toString()}`);
    console.error(`Missing: ${(required - balance).toString()}`);
    console.error("");
    console.error("Send more VIB, then run:");
    console.error("  pnpm e2e:vibmath:lumen:preflight");
    console.error("");

    // Update public cache with latest balance
    const pub = await loadIdentityPublic(cacheDir);
    if (pub) {
      await saveIdentityPublic(cacheDir, {
        ...pub,
        funding: {
          ...pub.funding,
          lastKnownFreeBalance: balance.toString(),
          lastCheckedAt: new Date().toISOString(),
        },
      });
    }

    throw new Error("Funding balance is not enough.");
  }

  console.log(`[lumen:preflight] Funding balance OK: ${balance.toString()} >= ${required.toString()}`);

  // ── 6. Prepare missing local agents ──────────────────────────────────────
  agents = await prepareMissingLocalAgents(agents, cacheDir);

  return { ok: true, identity, agents, cacheDir };
}

// ── Agent preparation ─────────────────────────────────────────────────────────

async function prepareMissingLocalAgents(
  agents: LumenAgentsPrivate,
  cacheDir: string,
): Promise<LumenAgentsPrivate> {
  const { readFile: _rf } = await import("node:fs/promises");
  const YAML = await import("yaml");

  // Read expected agents from scenario
  const scenarioPath = path.join(SCENARIO, "agents.yaml");
  const raw = await _rf(scenarioPath, "utf8");
  const parsed = YAML.parse(raw) as { agents: Array<{ id: string; principalId: string }> };
  const expectedAgents = parsed.agents;

  const cachedIds = new Set(agents.agents.map((a) => a.agentId));
  const missingAgents = expectedAgents.filter((a) => !cachedIds.has(a.id));

  if (missingAgents.length === 0) {
    console.log(`[lumen:agents] All ${expectedAgents.length} expected agents already cached.`);
    return agents;
  }

  console.log(`[lumen:agents] Expected agents: ${expectedAgents.length}`);
  console.log(`[lumen:agents] Cached agents: ${agents.agents.length}`);
  console.log(`[lumen:agents] Generating missing agents: ${missingAgents.length}`);

  const { generateAgentKeypair } = await import("./lumenAgentCache.js");
  const newAgents: CachedAgentPrivate[] = [];

  for (const agent of missingAgents) {
    const keypair = await generateAgentKeypair();
    const agentRef = computeAgentRef(agent.id);
    const cached: CachedAgentPrivate = {
      agentId: agent.id,
      principalId: agent.principalId,
      localKeyId: `lumen-vibmath-${agent.id}`,
      signerUri: keypair.signerUri,
      publicAddress: keypair.publicAddress,
      publicKey: keypair.publicKey,
      agentRef,
      bondAmount: process.env.VIBLY_E2E_TESTNET_BOND_AMOUNT ?? "100",
      bondStatus: "pending",
    };
    newAgents.push(cached);
    console.log(`[lumen:agents]   Generated: ${agent.id} (${keypair.publicAddress})`);
  }

  const updatedAgents: LumenAgentsPrivate = {
    ...agents,
    updatedAt: new Date().toISOString(),
    agents: [...agents.agents, ...newAgents],
  };

  await saveAgentsPrivate(cacheDir, updatedAgents);

  // Update public cache
  const publicAgents: LumenAgentsPublic = {
    version: 1,
    profile: "lumen",
    network: "lumen",
    createdAt: updatedAgents.createdAt,
    updatedAt: updatedAgents.updatedAt,
    agents: updatedAgents.agents.map((a) => ({
      agentId: a.agentId,
      principalId: a.principalId,
      publicAddress: a.publicAddress,
      publicKey: a.publicKey,
      agentRef: a.agentRef,
      chainAgentId: a.chainAgentId,
      bondAmount: a.bondAmount,
      bondStatus: a.bondStatus,
    })),
  };
  await saveAgentsPublic(cacheDir, publicAgents);

  console.log(`[lumen:agents] Generated ${newAgents.length} missing agents.`);
  return updatedAgents;
}

// ── Balance calculation ───────────────────────────────────────────────────────

async function calculateRequiredBalance(agents: LumenAgentsPrivate): Promise<bigint> {
  const explicitMin = process.env.VIBLY_E2E_LUMEN_REQUIRED_MIN_BALANCE;
  if (explicitMin) return BigInt(explicitMin);

  const bondAmount = BigInt(process.env.VIBLY_E2E_TESTNET_BOND_AMOUNT ?? "100");
  const feeBufferRatio = Number(process.env.VIBLY_E2E_LUMEN_FEE_BUFFER_RATIO ?? "0.1");
  const agentCount = BigInt(Math.max(agents.agents.length, 1));
  const baseAmount = bondAmount * agentCount;
  const feeBuffer = BigInt(Math.ceil(Number(baseAmount) * feeBufferRatio));
  return baseAmount + feeBuffer;
}

// ── URL resolution ────────────────────────────────────────────────────────────

function resolveChainRpcUrl(): string {
  return (
    process.env.VIBLY_E2E_CHAIN_RPC_URL ??
    process.env.LUMEN_CHAIN_RPC_URL ??
    process.env.SUBSTRATE_RPC_URL ??
    ""
  );
}

function resolveGraphqlUrl(): string {
  return (
    process.env.VIBLY_E2E_INDEXER_URL ??
    process.env.LUMEN_INDEXER_GRAPHQL_URL ??
    process.env.SUBSTRATE_INDEXER_URL ??
    ""
  );
}

function resolveCoordinatorUrl(): string {
  return (
    process.env.COORDINATOR_URL ??
    process.env.LUMEN_COORDINATOR_URL ??
    "http://127.0.0.1:8787"
  );
}
