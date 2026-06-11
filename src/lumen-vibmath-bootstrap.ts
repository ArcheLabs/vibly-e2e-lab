/**
 * Lumen VibMath bootstrap — identity-first entry point.
 *
 * Supports discrete phases controlled by VIBLY_E2E_LUMEN_BOOTSTRAP_MODE:
 *
 *   identity-init   Generate local identity keypair and optionally register on chain.
 *   identity-sync   Sync identity and agent state from chain/indexer and print diff.
 *   preflight       Run full preflight (cache check, chain sync, balance check, agent prep).
 *   agents-prepare  Generate missing local agent keys without registering on chain.
 *
 * Usage:
 *   pnpm e2e:vibmath:lumen:identity:init
 *   pnpm e2e:vibmath:lumen:identity:sync
 *   pnpm e2e:vibmath:lumen:preflight
 *   pnpm e2e:vibmath:lumen:agents:prepare
 */

import process from "node:process";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  defaultLumenCacheDir,
  loadIdentityPrivate,
  loadIdentityPublic,
  saveIdentityPrivate,
  saveIdentityPublic,
  generateIdentityKeypair,
  computeAgentRef,
  type LumenIdentityPrivate,
  type LumenIdentityPublic,
} from "./lumenIdentityCache.js";
import {
  loadAgentsPrivate,
  saveAgentsPrivate,
  saveAgentsPublic,
  generateAgentKeypair,
  type LumenAgentsPrivate,
  type LumenAgentsPublic,
  type CachedAgentPrivate,
} from "./lumenAgentCache.js";
import {
  syncLumenChainState,
  computeLumenDiff,
  printLumenDiff,
  saveLastDiff,
  saveChainCache,
} from "./lumenChainSync.js";

const SCENARIO = path.resolve(import.meta.dirname, "..", "scenarios", "vibing-math");

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const mode = process.env.VIBLY_E2E_LUMEN_BOOTSTRAP_MODE;
  if (!mode) {
    throw new Error(
      "VIBLY_E2E_LUMEN_BOOTSTRAP_MODE is required. Valid values: identity-init, identity-sync, preflight, agents-prepare",
    );
  }

  if (mode === "identity-init") {
    await initLumenIdentity();
    return;
  }

  if (mode === "identity-sync") {
    await syncLumenIdentityAndPrintDiff();
    return;
  }

  if (mode === "preflight") {
    await runLumenPreflightStandalone();
    return;
  }

  if (mode === "agents-prepare") {
    await prepareLumenAgents();
    return;
  }

  throw new Error(`Unsupported VIBLY_E2E_LUMEN_BOOTSTRAP_MODE=${mode}`);
}

// ── Identity init ─────────────────────────────────────────────────────────────

async function initLumenIdentity(): Promise<void> {
  const cacheDir = defaultLumenCacheDir();
  const existingPrivate = await loadIdentityPrivate(cacheDir);

  // If private cache already exists
  if (existingPrivate) {
    // Case 1: identityId already exists → nothing to do
    if (existingPrivate.identity.identityId) {
      console.log("[lumen:identity] Identity cache already exists.");
      console.log(`[lumen:identity] Network: ${existingPrivate.network}`);
      console.log(`[lumen:identity] Public address: ${existingPrivate.identity.publicAddress}`);
      console.log(`[lumen:identity] Identity ID: ${existingPrivate.identity.identityId}`);

      const pub = await loadIdentityPublic(cacheDir);
      if (pub) {
        console.log(`[lumen:identity] Last known balance: ${pub.funding.lastKnownFreeBalance}`);
      }

      console.log("");
      console.log("[lumen:identity] Next step:");
      console.log("  pnpm e2e:vibmath:lumen:preflight");
      return;
    }

    // Case 2: identityId missing, status is pending_funding (or undefined)
    // Try registering again with cached credentials (no keypair regeneration)
    console.log("[lumen:identity] Identity cache exists but not yet registered on chain.");
    console.log(`[lumen:identity] Network: ${existingPrivate.network}`);
    console.log(`[lumen:identity] Public address: ${existingPrivate.identity.publicAddress}`);

    // Print balance from public cache if available
    const pub = await loadIdentityPublic(cacheDir);
    if (pub) {
      console.log(`[lumen:identity] Last known balance: ${pub.funding.lastKnownFreeBalance}`);
    }

    console.log("[lumen:identity] Attempting to register identity on chain with cached keypair…");

    try {
      const identityId = await registerIdentityOnChain(
        existingPrivate.identity.publicAddress,
        existingPrivate.identity.signerUri,
      );

      // Registration succeeded — update caches
      const now = new Date().toISOString();

      // Update private cache
      const updatedPrivate: LumenIdentityPrivate = {
        ...existingPrivate,
        updatedAt: now,
        identity: {
          ...existingPrivate.identity,
          identityId,
          status: "registered",
        },
      };
      await saveIdentityPrivate(cacheDir, updatedPrivate);

      // Update public cache
      const existingPublic = pub ?? {
        version: 1 as const,
        profile: "lumen" as const,
        network: "lumen" as const,
        createdAt: now,
        updatedAt: now,
        identity: {
          localKeyId: existingPrivate.identity.localKeyId,
          publicAddress: existingPrivate.identity.publicAddress,
          publicKey: existingPrivate.identity.publicKey,
          identityId,
        },
        funding: {
          requiredMinimumBalance: "1000",
          lastKnownFreeBalance: "0",
          lastCheckedAt: now,
        },
      };
      const updatedPublic: LumenIdentityPublic = {
        ...existingPublic,
        updatedAt: now,
        identity: {
          ...existingPublic.identity,
          identityId,
        },
      };
      await saveIdentityPublic(cacheDir, updatedPublic);

      console.log(`[lumen:identity] Identity registered: ID=${identityId}`);
      console.log("");
      console.log("Next step:");
      console.log("  pnpm e2e:vibmath:lumen:preflight");
    } catch (err) {
      // Registration failed again — keep pending_funding, print original error
      console.warn(`[lumen:identity] Could not register identity on chain: ${String(err)}`);
      console.warn("[lumen:identity] The funding address may still need a balance.");
      console.warn("[lumen:identity] Identity remains pending_funding.");
      console.warn("");
      console.warn("Send enough VIB to the funding address, then re-run:");
      console.warn("  pnpm e2e:vibmath:lumen:identity:init");
    }
    return;
  }

  // Generate new keypair
  console.log("[lumen:identity] Generating new identity keypair…");
  const keypair = await generateIdentityKeypair();

  // Try to register on chain. If the account has no balance, the chain may reject.
  let identityId: string | undefined;
  let status: "pending_funding" | "registered" = "pending_funding";

  try {
    console.log("[lumen:identity] Registering identity on chain…");
    identityId = await registerIdentityOnChain(keypair.publicAddress, keypair.signerUri);
    status = "registered";
    console.log(`[lumen:identity] Identity registered: ID=${identityId}`);
  } catch (err) {
    console.warn(`[lumen:identity] Could not register identity on chain: ${String(err)}`);
    console.warn("[lumen:identity] The funding address may need a balance first.");
    console.warn("[lumen:identity] Identity will be saved as pending_funding.");
  }

  // Save private cache
  const now = new Date().toISOString();
  const privateData = {
    version: 1 as const,
    profile: "lumen" as const,
    network: "lumen" as const,
    createdAt: now,
    updatedAt: now,
    identity: {
      localKeyId: "lumen-vibmath-shared-identity",
      signerUri: keypair.signerUri,
      publicAddress: keypair.publicAddress,
      publicKey: keypair.publicKey,
      identityId,
      status,
    },
  };

  await saveIdentityPrivate(cacheDir, privateData);

  // Save public cache
  const publicData = {
    version: 1 as const,
    profile: "lumen" as const,
    network: "lumen" as const,
    createdAt: now,
    updatedAt: now,
    identity: {
      localKeyId: "lumen-vibmath-shared-identity",
      publicAddress: keypair.publicAddress,
      publicKey: keypair.publicKey,
      identityId,
    },
    funding: {
      requiredMinimumBalance: "1000",
      lastKnownFreeBalance: "0",
      lastCheckedAt: now,
    },
  };

  await saveIdentityPublic(cacheDir, publicData);

  // Print result
  console.log("");
  console.log("[lumen:identity] Identity initialized.");
  console.log("");
  console.log(`Network: Lumen`);
  console.log(`Identity ID: ${identityId ?? "pending"}`);
  console.log(`Funding address: ${keypair.publicAddress}`);
  console.log(`Required minimum balance: 1000 VIB`);
  console.log("");

  if (status === "registered") {
    console.log("Next step:");
    console.log("  pnpm e2e:vibmath:lumen:preflight");
  } else {
    console.log("Next step:");
    console.log("  Send enough VIB to the funding address, then re-run:");
    console.log("  pnpm e2e:vibmath:lumen:identity:init");
  }
}

// ── Identity sync ─────────────────────────────────────────────────────────────

async function syncLumenIdentityAndPrintDiff(): Promise<void> {
  const cacheDir = defaultLumenCacheDir();
  const identity = await loadIdentityPrivate(cacheDir);
  if (!identity) {
    console.error("Lumen identity cache was not found.");
    console.error("Run: pnpm e2e:vibmath:lumen:identity:init");
    process.exit(1);
  }

  if (!identity.identity.identityId) {
    console.error("Lumen identity is not yet registered on chain.");
    console.error("Run: pnpm e2e:vibmath:lumen:identity:init");
    process.exit(1);
  }

  const agents = await loadAgentsPrivate(cacheDir);
  const agentsData: LumenAgentsPrivate = agents ?? {
    version: 1,
    profile: "lumen",
    network: "lumen",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agents: [],
  };

  const chainRpcUrl = resolveChainRpcUrl();
  const graphqlUrl = resolveGraphqlUrl();

  if (!chainRpcUrl || !graphqlUrl) {
    console.error("Chain RPC URL and Indexer GraphQL URL are required.");
    console.error("Set VIBLY_E2E_CHAIN_RPC_URL / LUMEN_CHAIN_RPC_URL and VIBLY_E2E_INDEXER_URL / LUMEN_INDEXER_GRAPHQL_URL.");
    process.exit(1);
  }

  console.log(`[lumen:sync] Syncing from chain: ${chainRpcUrl}`);
  console.log(`[lumen:sync] Syncing from indexer: ${graphqlUrl}`);

  const chainState = await syncLumenChainState(chainRpcUrl, graphqlUrl, identity, agentsData);
  await saveChainCache(cacheDir, chainState);

  const diff = computeLumenDiff(identity, agentsData, chainState);
  await saveLastDiff(cacheDir, diff);
  printLumenDiff(diff);

  console.log("");
  console.log(`[lumen:sync] Chain cache saved to: ${path.join(cacheDir, "chain-cache.json")}`);
  if (diff.summary.hasDiff) {
    console.log(`[lumen:sync] Diff saved to: ${path.join(cacheDir, "last-diff.json")}`);
  }
}

// ── Standalone preflight ──────────────────────────────────────────────────────

async function runLumenPreflightStandalone(): Promise<void> {
  // Import and delegate to the shared preflight module
  const { runLumenPreflight } = await import("./lumenPreflight.js");
  const result = await runLumenPreflight();
  console.log("");
  console.log("[lumen:preflight] All checks passed.");
  console.log("");
  console.log("Next step:");
  console.log("  pnpm e2e:vibmath:lumen");
}

// ── Agents prepare ────────────────────────────────────────────────────────────

async function prepareLumenAgents(): Promise<void> {
  const cacheDir = defaultLumenCacheDir();
  const identity = await loadIdentityPrivate(cacheDir);
  if (!identity) {
    console.error("Lumen identity cache was not found.");
    console.error("Run: pnpm e2e:vibmath:lumen:identity:init");
    process.exit(1);
  }

  if (!identity.identity.identityId) {
    console.error("Lumen identity is not yet registered on chain.");
    console.error("Run: pnpm e2e:vibmath:lumen:identity:init");
    process.exit(1);
  }

  const { readFile: rf } = await import("node:fs/promises");
  const YAML = await import("yaml");

  // Read expected agents from scenario
  const scenarioPath = path.join(SCENARIO, "agents.yaml");
  const raw = await rf(scenarioPath, "utf8");
  const parsed = YAML.parse(raw) as { agents: Array<{ id: string; principalId: string }> };
  const expectedAgents = parsed.agents;

  // Load existing agent cache
  let agents = await loadAgentsPrivate(cacheDir);
  const cachedIds = new Set((agents?.agents ?? []).map((a) => a.agentId));
  const missingAgents = expectedAgents.filter((a) => !cachedIds.has(a.id));

  if (missingAgents.length === 0) {
    console.log(`[lumen:agents] All ${expectedAgents.length} expected agents already cached.`);
    console.log("");
    console.log("Next step:");
    console.log("  pnpm e2e:vibmath:lumen");
    return;
  }

  console.log(`[lumen:agents] Expected agents: ${expectedAgents.length}`);
  console.log(`[lumen:agents] Cached agents: ${agents?.agents.length ?? 0}`);
  console.log(`[lumen:agents] Generating missing agents: ${missingAgents.length}`);

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
  }

  const now = new Date().toISOString();
  const updatedAgents: LumenAgentsPrivate = {
    version: 1,
    profile: "lumen",
    network: "lumen",
    createdAt: agents?.createdAt ?? now,
    updatedAt: now,
    agents: [...(agents?.agents ?? []), ...newAgents],
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
  for (const a of newAgents) {
    console.log(`  - ${a.agentId} (${a.publicAddress})`);
  }
  console.log("");
  console.log("Next step:");
  console.log("  pnpm e2e:vibmath:lumen");
}

// ── Chain registration helper ─────────────────────────────────────────────────

async function registerIdentityOnChain(publicAddress: string, signerUri: string): Promise<string> {
  const chainRpcUrl = resolveChainRpcUrl();
  const chainId = process.env.VIBLY_E2E_CHAIN_ID ?? "substrate:vibly-testnet";

  if (!chainRpcUrl) {
    throw new Error("Chain RPC URL is required. Set VIBLY_E2E_CHAIN_RPC_URL or LUMEN_CHAIN_RPC_URL.");
  }

  // Use vibly-client CLI to register the identity
  const { spawn } = await import("node:child_process");
  const ROOT = path.resolve(import.meta.dirname, "..");
  const CLIENT_DIR = path.resolve(ROOT, "../vibly-client");

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "exec", "tsx", "src/main.ts",
        "agent", "identity", "register-chain",
        "--rpc-url", chainRpcUrl,
        "--signer-uri", signerUri,
        "--chain-id", chainId,
        "--json",
      ],
      {
        cwd: CLIENT_DIR,
        env: { ...process.env },
        stdio: "pipe",
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (buf: Buffer) => { stdout += buf.toString(); });
    child.stderr.on("data", (buf: Buffer) => { stderr += buf.toString(); });

    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`vibly CLI exited with code ${String(code)}\n${stderr}`));
        return;
      }
      const lastBrace = stdout.lastIndexOf("\n{");
      const jsonStr = lastBrace >= 0 ? stdout.slice(lastBrace + 1).trim() : stdout.trim();
      if (!jsonStr.startsWith("{")) {
        reject(new Error(`No JSON in CLI output.\nstdout: ${stdout.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(jsonStr) as { ok?: boolean; data?: { identityId?: string } };
        const identityId = parsed.data?.identityId;
        if (!identityId) {
          reject(new Error("CLI response did not include identityId."));
          return;
        }
        resolve(identityId);
      } catch (e) {
        reject(new Error(`Failed to parse CLI JSON: ${String(e)}`));
      }
    });
    child.on("error", reject);
  });
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

// ── Execute ───────────────────────────────────────────────────────────────────

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
