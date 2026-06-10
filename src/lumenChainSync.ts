/**
 * Lumen chain sync and diff comparison.
 *
 * Syncs identity and agent state from chain/indexer and compares against
 * the local cache. Produces a diff that can be persisted and inspected
 * before the bootstrap script starts agents.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultLumenCacheDir } from "./lumenIdentityCache.js";
import type { LumenIdentityPrivate, LumenIdentityPublic } from "./lumenIdentityCache.js";
import type { LumenAgentsPrivate } from "./lumenAgentCache.js";
import { queryIndexerLedger, type IndexerLedger } from "./lifecycle/indexer.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LumenChainIdentityState {
  identityId: string;
  publicAddress: string;
  existsOnChain: boolean;
  freeBalance: string;
}

export interface LumenChainAgentState {
  agentId: string;
  agentRef: string;
  chainAgentId?: string;
  existsOnChain: boolean;
  ledgerStatus?: string;
  activeAmount?: string;
  unbondingAmount?: string;
}

export interface LumenChainState {
  syncedAt: string;
  identity: LumenChainIdentityState;
  agents: LumenChainAgentState[];
}

// ── Diff types ────────────────────────────────────────────────────────────────

export interface DiffEntry {
  ref: string;
  reason: string;
}

export interface DiffMismatch {
  agentId: string;
  field: string;
  local: string;
  chain: string;
}

export interface LumenDiff {
  version: 1;
  profile: "lumen";
  network: "lumen";
  createdAt: string;
  summary: {
    hasDiff: boolean;
    severity: "ok" | "blocking" | "warning";
  };
  missingLocal: {
    identity: DiffEntry[];
    agents: DiffEntry[];
  };
  missingOnChain: {
    agents: DiffEntry[];
  };
  mismatches: DiffMismatch[];
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export function chainCachePath(cacheDir: string): string {
  return path.join(cacheDir, "chain-cache.json");
}

export function lastDiffPath(cacheDir: string): string {
  return path.join(cacheDir, "last-diff.json");
}

// ── Chain sync ────────────────────────────────────────────────────────────────

/**
 * Sync identity state from the chain.
 * Uses @polkadot/api to query the chain for identity existence and balance.
 */
export async function syncIdentityFromChain(
  chainRpcUrl: string,
  identityId: string,
  publicAddress: string,
): Promise<LumenChainIdentityState> {
  const { ApiPromise, WsProvider } = await import("@polkadot/api");

  const api = await ApiPromise.create({ provider: new WsProvider(chainRpcUrl) });
  try {
    const accountInfo = await api.query.system.account(publicAddress) as unknown as { data: { free: { toString(): string } } };
    const freeBalance = accountInfo.data.free.toString();

    // Check if identity exists by querying the identity pallet
    let existsOnChain = false;
    try {
      const identity = await api.query.identityCore.identities(identityId);
      existsOnChain = (identity as { isSome?: boolean }).isSome === true;
    } catch {
      // Identity pallet may not be queryable, assume exists if no error
      existsOnChain = true;
    }

    return {
      identityId,
      publicAddress,
      existsOnChain,
      freeBalance,
    };
  } finally {
    await api.disconnect();
  }
}

/**
 * Sync agent state from the indexer.
 */
export async function syncAgentFromIndexer(
  graphqlUrl: string,
  chainAgentId: string,
  agentId: string,
  agentRef: string,
): Promise<LumenChainAgentState> {
  let ledger: IndexerLedger | undefined;
  try {
    ledger = await queryIndexerLedger(graphqlUrl, chainAgentId);
  } catch {
    // Indexer may not have the ledger yet
  }

  return {
    agentId,
    agentRef,
    chainAgentId,
    existsOnChain: ledger !== undefined,
    ledgerStatus: ledger?.status,
    activeAmount: ledger?.activeAmount,
    unbondingAmount: ledger?.unbondingAmount,
  };
}

/**
 * Full sync: identity from chain, all agents from indexer.
 */
export async function syncLumenChainState(
  chainRpcUrl: string,
  graphqlUrl: string,
  identity: LumenIdentityPrivate,
  agents: LumenAgentsPrivate,
): Promise<LumenChainState> {
  const chainIdentity = await syncIdentityFromChain(
    chainRpcUrl,
    identity.identity.identityId ?? "",
    identity.identity.publicAddress,
  );

  const chainAgents: LumenChainAgentState[] = [];
  for (const agent of agents.agents) {
    if (agent.chainAgentId) {
      const state = await syncAgentFromIndexer(graphqlUrl, agent.chainAgentId, agent.agentId, agent.agentRef);
      chainAgents.push(state);
    } else {
      chainAgents.push({
        agentId: agent.agentId,
        agentRef: agent.agentRef,
        chainAgentId: undefined,
        existsOnChain: false,
      });
    }
  }

  return {
    syncedAt: new Date().toISOString(),
    identity: chainIdentity,
    agents: chainAgents,
  };
}

// ── Diff computation ──────────────────────────────────────────────────────────

/**
 * Compare local cache against chain state and produce a diff.
 */
export function computeLumenDiff(
  identity: LumenIdentityPrivate,
  agents: LumenAgentsPrivate,
  chainState: LumenChainState,
): LumenDiff {
  const missingLocalIdentity: DiffEntry[] = [];
  const missingLocalAgents: DiffEntry[] = [];
  const missingOnChainAgents: DiffEntry[] = [];
  const mismatches: DiffMismatch[] = [];

  // Check identity
  if (chainState.identity.existsOnChain && !identity.identity.identityId) {
    missingLocalIdentity.push({
      ref: chainState.identity.publicAddress,
      reason: "exists_on_chain_but_missing_in_local_cache",
    });
  }

  // Check agents: what's on chain but not in local cache
  for (const chainAgent of chainState.agents) {
    if (chainAgent.existsOnChain) {
      const local = agents.agents.find((a) => a.chainAgentId === chainAgent.chainAgentId);
      if (!local) {
        missingLocalAgents.push({
          ref: chainAgent.agentRef,
          reason: "exists_on_chain_but_missing_in_local_cache",
        });
      }
    }
  }

  // Check agents: what's in local cache but not on chain
  for (const localAgent of agents.agents) {
    if (localAgent.chainAgentId) {
      const chain = chainState.agents.find((a) => a.chainAgentId === localAgent.chainAgentId);
      if (!chain || !chain.existsOnChain) {
        missingOnChainAgents.push({
          ref: localAgent.agentRef,
          reason: "exists_in_local_cache_but_missing_on_chain",
        });
      } else if (chain.ledgerStatus && localAgent.bondStatus && chain.ledgerStatus !== localAgent.bondStatus) {
        mismatches.push({
          agentId: localAgent.agentId,
          field: "bondStatus",
          local: localAgent.bondStatus,
          chain: chain.ledgerStatus,
        });
      }
    }
  }

  const hasDiff =
    missingLocalIdentity.length > 0 ||
    missingLocalAgents.length > 0 ||
    missingOnChainAgents.length > 0 ||
    mismatches.length > 0;

  const severity: "ok" | "blocking" | "warning" =
    missingLocalIdentity.length > 0 ? "blocking"
    : missingLocalAgents.length > 0 ? "blocking"
    : missingOnChainAgents.length > 0 ? "warning"
    : mismatches.length > 0 ? "warning"
    : "ok";

  return {
    version: 1,
    profile: "lumen",
    network: "lumen",
    createdAt: new Date().toISOString(),
    summary: { hasDiff, severity },
    missingLocal: {
      identity: missingLocalIdentity,
      agents: missingLocalAgents,
    },
    missingOnChain: {
      agents: missingOnChainAgents,
    },
    mismatches,
  };
}

// ── Persist ───────────────────────────────────────────────────────────────────

export async function saveChainCache(cacheDir: string, state: LumenChainState): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(chainCachePath(cacheDir), JSON.stringify(state, null, 2) + "\n");
}

export async function saveLastDiff(cacheDir: string, diff: LumenDiff): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(lastDiffPath(cacheDir), JSON.stringify(diff, null, 2) + "\n");
}

// ── Print helpers ─────────────────────────────────────────────────────────────

export function printLumenDiff(diff: LumenDiff): void {
  if (!diff.summary.hasDiff) {
    console.log("[lumen:sync] Local cache and chain state are consistent.");
    return;
  }

  console.log("[lumen:sync] Local cache and chain state differ.");
  console.log(`[lumen:sync] Severity: ${diff.summary.severity}`);

  for (const entry of diff.missingLocal.identity) {
    console.log(`[lumen:sync]   Missing local identity: ${entry.ref} (${entry.reason})`);
  }
  for (const entry of diff.missingLocal.agents) {
    console.log(`[lumen:sync]   Missing local agent: ${entry.ref} (${entry.reason})`);
  }
  for (const entry of diff.missingOnChain.agents) {
    console.log(`[lumen:sync]   Missing on-chain agent: ${entry.ref} (${entry.reason})`);
  }
  for (const m of diff.mismatches) {
    console.log(`[lumen:sync]   Mismatch ${m.agentId}: ${m.field} local=${m.local} chain=${m.chain}`);
  }
}
