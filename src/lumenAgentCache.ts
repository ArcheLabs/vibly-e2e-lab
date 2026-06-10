/**
 * Lumen VibMath agent cache.
 *
 * Stores per-agent key material and on-chain binding state so that
 * the bootstrap script can resume across sessions without re-registering
 * agents that are already active on chain.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultLumenCacheDir } from "./lumenIdentityCache.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CachedAgentPrivate {
  agentId: string;
  principalId: string;
  localKeyId: string;
  signerUri: string;
  publicAddress: string;
  publicKey: string;
  identityId?: string;
  agentRef: string;
  chainAgentId?: string;
  bondAmount: string;
  bondStatus?: "pending" | "active" | "unbonding" | "released";
}

export interface CachedAgentPublic {
  agentId: string;
  principalId: string;
  publicAddress: string;
  publicKey: string;
  identityId?: string;
  agentRef: string;
  chainAgentId?: string;
  bondAmount: string;
  bondStatus?: string;
}

export interface LumenAgentsPrivate {
  version: 1;
  profile: "lumen";
  network: "lumen";
  createdAt: string;
  updatedAt: string;
  agents: CachedAgentPrivate[];
}

export interface LumenAgentsPublic {
  version: 1;
  profile: "lumen";
  network: "lumen";
  createdAt: string;
  updatedAt: string;
  agents: CachedAgentPublic[];
}

// ── Paths ─────────────────────────────────────────────────────────────────────

export function agentsPrivatePath(cacheDir: string): string {
  return path.join(cacheDir, "agents.private.json");
}

export function agentsPublicPath(cacheDir: string): string {
  return path.join(cacheDir, "agents.public.json");
}

// ── Load / Save ───────────────────────────────────────────────────────────────

export async function loadAgentsPrivate(cacheDir: string): Promise<LumenAgentsPrivate | undefined> {
  try {
    const raw = await readFile(agentsPrivatePath(cacheDir), "utf8");
    return JSON.parse(raw) as LumenAgentsPrivate;
  } catch {
    return undefined;
  }
}

export async function loadAgentsPublic(cacheDir: string): Promise<LumenAgentsPublic | undefined> {
  try {
    const raw = await readFile(agentsPublicPath(cacheDir), "utf8");
    return JSON.parse(raw) as LumenAgentsPublic;
  } catch {
    return undefined;
  }
}

export async function saveAgentsPrivate(cacheDir: string, data: LumenAgentsPrivate): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const filePath = agentsPrivatePath(cacheDir);
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function saveAgentsPublic(cacheDir: string, data: LumenAgentsPublic): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(agentsPublicPath(cacheDir), JSON.stringify(data, null, 2) + "\n");
}

/**
 * Generate a local keypair for an agent.
 * Uses @polkadot/keyring to produce a sr25519 key.
 */
export async function generateAgentKeypair(): Promise<{
  publicAddress: string;
  publicKey: string;
  signerUri: string;
}> {
  const { Keyring } = await import("@polkadot/keyring");
  const { cryptoWaitReady, mnemonicGenerate } = await import("@polkadot/util-crypto");

  await cryptoWaitReady();
  const mnemonic = mnemonicGenerate(12);
  const keyring = new Keyring({ type: "sr25519" });
  const pair = keyring.addFromUri(mnemonic);

  return {
    publicAddress: pair.address,
    publicKey: `0x${Buffer.from(pair.publicKey).toString("hex")}`,
    signerUri: mnemonic,
  };
}

/**
 * Find missing agents by comparing the scenario's agent list against the local cache.
 * Returns only the agents that do not yet have a cache entry.
 */
export function findMissingAgents(
  expectedAgents: Array<{ id: string; principalId: string }>,
  cachedAgents: LumenAgentsPrivate | undefined,
): Array<{ id: string; principalId: string }> {
  if (!cachedAgents) return expectedAgents;

  const cachedIds = new Set(cachedAgents.agents.map((a) => a.agentId));
  return expectedAgents.filter((agent) => !cachedIds.has(agent.id));
}
