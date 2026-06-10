/**
 * Lumen VibMath identity cache.
 *
 * Stores the shared chain identity key material locally so that the
 * bootstrap script can resume across sessions without re-registering.
 *
 * Private files (*.private.json) are written with 0600 permissions
 * and stored outside the repository by default. Public files (*.public.json)
 * only contain addresses and identity ids — no secret material.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, randomBytes } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LumenIdentityPrivate {
  version: 1;
  profile: "lumen";
  network: "lumen";
  createdAt: string;
  updatedAt: string;
  identity: {
    localKeyId: string;
    signerUri: string;
    publicAddress: string;
    publicKey: string;
    identityId?: string;
    status?: "pending_funding" | "registered";
  };
}

export interface LumenIdentityPublic {
  version: 1;
  profile: "lumen";
  network: "lumen";
  createdAt: string;
  updatedAt: string;
  identity: {
    localKeyId: string;
    publicAddress: string;
    publicKey: string;
    identityId?: string;
  };
  funding: {
    requiredMinimumBalance: string;
    lastKnownFreeBalance: string;
    lastCheckedAt: string;
  };
}

// ── Default cache directory ───────────────────────────────────────────────────

export function defaultLumenCacheDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
  return process.env.VIBLY_E2E_LUMEN_CACHE_DIR ?? path.join(home, ".vibly-e2e-lab", "lumen-vibmath");
}

export function identityPrivatePath(cacheDir: string): string {
  return path.join(cacheDir, "identity.private.json");
}

export function identityPublicPath(cacheDir: string): string {
  return path.join(cacheDir, "identity.public.json");
}

// ── Load / Save ───────────────────────────────────────────────────────────────

export async function loadIdentityPrivate(cacheDir: string): Promise<LumenIdentityPrivate | undefined> {
  try {
    const raw = await readFile(identityPrivatePath(cacheDir), "utf8");
    return JSON.parse(raw) as LumenIdentityPrivate;
  } catch {
    return undefined;
  }
}

export async function loadIdentityPublic(cacheDir: string): Promise<LumenIdentityPublic | undefined> {
  try {
    const raw = await readFile(identityPublicPath(cacheDir), "utf8");
    return JSON.parse(raw) as LumenIdentityPublic;
  } catch {
    return undefined;
  }
}

export async function saveIdentityPrivate(cacheDir: string, data: LumenIdentityPrivate): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const filePath = identityPrivatePath(cacheDir);
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function saveIdentityPublic(cacheDir: string, data: LumenIdentityPublic): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(identityPublicPath(cacheDir), JSON.stringify(data, null, 2) + "\n");
}

/**
 * Generate a local keypair for a new identity.
 * Uses the vibly-client CLI's `agent identity register-chain` command.
 *
 * If the chain requires the funding address to have a balance before
 * register-chain succeeds, the caller should first output the address
 * and ask the user to transfer funds, then retry.
 */
export async function generateIdentityKeypair(): Promise<{
  publicAddress: string;
  publicKey: string;
  signerUri: string;
}> {
  // Use polkadot's keyring to generate a sr25519 keypair locally.
  // This avoids calling the CLI for key generation.
  const { Keyring } = await import("@polkadot/keyring");
  const { cryptoWaitReady, mnemonicGenerate, mnemonicToMiniSecret } = await import("@polkadot/util-crypto");

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
 * Compute a deterministic agent ref hash for an agent.
 */
export function computeAgentRef(agentId: string, salt?: string): string {
  const refSalt = salt ?? "lumen-vibmath";
  const hash = createHash("sha256")
    .update(`vibly-e2e-agent:${refSalt}:${agentId}`)
    .digest("hex");
  return `hash:0x${hash}`;
}
