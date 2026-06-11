/**
 * Chain seed helpers for the E2E runner.
 *
 * Each agent needs to be bootstrapped on-chain before the main deterministic
 * scenario can start:
 *
 *  1. register_identity  (pallet_identity_core)
 *  2. register_agent     (pallet_onboarding_distribution)
 *  3. bond_agent         (pallet_agent_staking)
 *
 * All three steps call the vibly-client CLI via `pnpm dev -- …` so that the
 * exact same code-path used by real operators is exercised.  The CLI is
 * invoked with --json so that receipts can be parsed programmatically.
 *
 * After bonding, the helpers wait for:
 *  - the indexer GraphQL to reflect an active ledger for the agent
 *  - the coordinator stake projection to show status=active after the runner
 *    registers the coordinator AgentProfile with the chain ids
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { queryIndexerLedger, type IndexerLedger } from "./lifecycle/indexer.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLIENT_DIR = path.resolve(ROOT, "../vibly-client");

// ── Public types ─────────────────────────────────────────────────────────────

export interface ChainSeedInput {
  agentId: string;
  /** Coordinator URL — used for waitForCoordinatorStakeSync. */
  coordinatorUrl: string;
  apiToken: string;
  chainRpcUrl: string;
  graphqlUrl: string;
  chainId: string;
  /** Amount to bond (in chain units as a decimal string). */
  bondAmount?: string;
  /** Dev account URI used as the root/owner signer (default: //Alice). */
  rootSignerUri?: string;

  /**
   * Existing identity id reused by multiple chain agents.
   * When provided, identity registration is skipped unless registerIdentity=true
   * and the implementation explicitly supports creating the shared identity.
   */
  sharedIdentityId?: string;

  /**
   * Whether to register a new identity before registering the chain agent.
   * Defaults to true when sharedIdentityId is absent.
   * Defaults to false when sharedIdentityId is present.
   */
  registerIdentity?: boolean;

  /**
   * Pre-computed agent ref hash. If unset, derived from agentId.
   */
  agentRef?: string;

  /**
   * Per-agent signer URI (instead of using rootSignerUri for all agents).
   */
  agentSignerUri?: string;

  /**
   * Funding source address (for receipt / logging only).
   */
  fundingAddress?: string;

  /**
   * If true and the indexer already shows an active ledger for this agent,
   * skip the bond step.
   */
  skipBondIfActive?: boolean;
}

export interface ChainSeedReceipt {
  agentId: string;
  identityId: string;
  chainAgentId: string;
  bondTxHash: string;
  indexerLedger: IndexerLedger;
}

// ── Main entry ────────────────────────────────────────────────────────────────

export async function seedChainAgent(input: ChainSeedInput): Promise<ChainSeedReceipt> {
  const rootSignerUri = input.rootSignerUri ?? "//Alice";
  const bondAmount = input.bondAmount ?? "100";
  const agentSignerUri = input.agentSignerUri ?? rootSignerUri;
  const sharedSignerOpts = [
    "--rpc-url", input.chainRpcUrl,
    "--signer-uri", agentSignerUri,
    "--chain-id", input.chainId,
    "--json",
  ];

  // ── Step 1: Register or reuse identity ────────────────────────────────────
  const shouldRegisterIdentity = input.registerIdentity ?? !input.sharedIdentityId;

  let identityId = input.sharedIdentityId;

  if (shouldRegisterIdentity) {
    console.log(`[chain-seed] Registering identity for agent ${input.agentId}…`);
    const identityReceipt = await spawnCliJson<{ identityId?: string }>([
      "agent", "identity", "register-chain",
      ...sharedSignerOpts,
    ]);
    if (!identityReceipt.identityId) {
      throw new Error(`register-identity did not return identityId for agent ${input.agentId}`);
    }
    identityId = identityReceipt.identityId;
    console.log(`[chain-seed] Identity registered: identityId=${identityId}`);
  } else {
    if (!identityId) {
      throw new Error(`sharedIdentityId is required when registerIdentity=false for agent ${input.agentId}`);
    }
    console.log(`[chain-seed] Reusing shared identity for agent ${input.agentId}: identityId=${identityId}`);
  }

  // Assert identityId is defined before proceeding
  if (!identityId) {
    throw new Error(`No identityId resolved for agent ${input.agentId}`);
  }

  // ── Step 2: Register agent on chain ──────────────────────────────────────
  // Use pre-computed agentRef if provided, otherwise derive from agentId.
  const agentRefValue = input.agentRef ?? `hash:0x${createHash("sha256").update(`vibly-e2e-agent:${input.agentId}`).digest("hex")}`;
  console.log(`[chain-seed] Registering chain agent for ${input.agentId} (agentRef=${agentRefValue.slice(0, 18)}…)…`);
  const registerReceipt = await spawnCliJson<{ agentId?: string }>([
    "agent", "register-chain",
    "--identity-id", identityId,
    "--agent-ref", agentRefValue,
    ...sharedSignerOpts,
  ]);
  if (!registerReceipt.agentId) {
    throw new Error(`register-agent did not return agentId for agent ${input.agentId}`);
  }
  const chainAgentId = registerReceipt.agentId;
  console.log(`[chain-seed] Chain agent registered: chainAgentId=${chainAgentId}`);

  // ── Step 3: Bond stake (skip if already active and skipBondIfActive is set) ─
  let bondTxHash = "";
  let indexerLedger: IndexerLedger;

  if (input.skipBondIfActive) {
    // Check if ledger is already active before bonding
    const existingLedger = await tryQueryIndexerLedger(input.graphqlUrl, chainAgentId);
    if (existingLedger && existingLedger.status === "active" && BigInt(existingLedger.activeAmount) >= BigInt(bondAmount)) {
      console.log(`[chain-seed] Skipping bond for ${input.agentId}: already active with ${existingLedger.activeAmount}`);
      indexerLedger = existingLedger;
      bondTxHash = "skipped";
    } else {
      // Bond is needed
      console.log(`[chain-seed] Bonding ${bondAmount} for agent ${input.agentId}…`);
      const bondReceipt = await spawnCliJson<{ txHash: string }>([
        "agent", "stake", "bond",
        "--identity-id", identityId,
        "--agent-id", chainAgentId,
        "--amount", bondAmount,
        ...sharedSignerOpts,
      ]);
      console.log(`[chain-seed] Bond tx submitted: txHash=${bondReceipt.txHash}`);
      bondTxHash = bondReceipt.txHash;

      console.log(`[chain-seed] Waiting for indexer ledger (chainAgentId=${chainAgentId.slice(0, 12)}…)…`);
      indexerLedger = await waitForIndexerActiveLedger(input.graphqlUrl, chainAgentId, 120_000);
      console.log(`[chain-seed] Indexer ledger confirmed active for ${input.agentId}`);
    }
  } else {
    console.log(`[chain-seed] Bonding ${bondAmount} for agent ${input.agentId}…`);
    const bondReceipt = await spawnCliJson<{ txHash: string }>([
      "agent", "stake", "bond",
      "--identity-id", identityId,
      "--agent-id", chainAgentId,
      "--amount", bondAmount,
      ...sharedSignerOpts,
    ]);
    console.log(`[chain-seed] Bond tx submitted: txHash=${bondReceipt.txHash}`);
    bondTxHash = bondReceipt.txHash;

    console.log(`[chain-seed] Waiting for indexer ledger (chainAgentId=${chainAgentId.slice(0, 12)}…)…`);
    indexerLedger = await waitForIndexerActiveLedger(input.graphqlUrl, chainAgentId, 120_000);
    console.log(`[chain-seed] Indexer ledger confirmed active for ${input.agentId}`);
  }

  return {
    agentId: input.agentId,
    identityId,
    chainAgentId,
    bondTxHash,
    indexerLedger,
  };
}

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Try to query the indexer ledger for an agent. Returns undefined if not found.
 */
async function tryQueryIndexerLedger(
  graphqlUrl: string,
  chainAgentId: string,
): Promise<IndexerLedger | undefined> {
  try {
    return await queryIndexerLedger(graphqlUrl, chainAgentId);
  } catch {
    return undefined;
  }
}

// ── Wait helpers ──────────────────────────────────────────────────────────────

export async function waitForIndexerActiveLedger(
  graphqlUrl: string,
  chainAgentId: string,
  timeoutMs = 60_000,
): Promise<IndexerLedger> {
  return waitFor(
    async () => {
      const ledger = await queryIndexerLedger(graphqlUrl, chainAgentId);
      return ledger?.status === "active" ? ledger : undefined;
    },
    `indexer active ledger for chainAgentId=${chainAgentId.slice(0, 12)}…`,
    timeoutMs,
  );
}

export async function waitForCoordinatorStakeSync(
  coordinatorUrl: string,
  apiToken: string,
  principalId: string,
  timeoutMs = 60_000,
  chainId?: string,
): Promise<void> {
  await waitFor(
    async () => {
      const resp = await fetch(`${coordinatorUrl}/agent-profiles/${principalId}`, {
        headers: coordinatorRequestHeaders(apiToken, chainId),
      });
      if (!resp.ok) return undefined;
      const body = (await resp.json()) as {
        data?: { agent?: { stakeLedger?: { status?: string } } };
      };
      return body.data?.agent?.stakeLedger?.status === "active" ? true : undefined;
    },
    `coordinator stake sync for principalId=${principalId}`,
    timeoutMs,
  );
}

function coordinatorRequestHeaders(apiToken: string, chainId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    "x-vibly-client-version": process.env.VIBLY_E2E_CLIENT_VERSION ?? "0.1.1",
    "x-vibly-contract-version": process.env.VIBLY_E2E_CONTRACT_VERSION ?? "0.1.1",
    "x-vibly-protocol-version": process.env.VIBLY_E2E_PROTOCOL_VERSION ?? "0.2",
    "x-vibly-client-package": process.env.VIBLY_E2E_CLIENT_PACKAGE ?? "vibly-e2e-lab",
    ...(chainId ? { "x-vibly-network-id": chainId } : {}),
  };
}

// ── Internal: CLI spawn helper ────────────────────────────────────────────────

async function spawnCliJson<T extends Record<string, unknown>>(args: string[]): Promise<T> {
  // Unwrap one level of the { ok, data } envelope that printOutput emits.
  const envelope = await spawnCli(args);
  if (
    envelope &&
    typeof envelope === "object" &&
    "ok" in envelope &&
    "data" in envelope
  ) {
    return (envelope as { data: T }).data;
  }
  return envelope as unknown as T;
}

async function spawnCli(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // Invoke tsx directly (via pnpm exec) to avoid pnpm's "--" separator being
    // forwarded to the script, which causes Commander.js to treat everything
    // after "--" as literal positional arguments and silently ignore --json.
    const child = spawn(
      "pnpm",
      ["exec", "tsx", "src/main.ts", ...args],
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
        reject(
          new Error(
            `vibly CLI exited with code ${String(code)}\nargs: ${args.join(" ")}\nstderr: ${stderr}\nstdout: ${stdout}`,
          ),
        );
        return;
      }
      // printOutput writes pretty-printed multi-line JSON.  Find the last JSON
      // object in stdout (starting from the last bare "{" on its own segment).
      const lastBrace = stdout.lastIndexOf("\n{");
      const jsonStr = lastBrace >= 0
        ? stdout.slice(lastBrace + 1).trim()
        : stdout.trim();
      if (!jsonStr.startsWith("{")) {
        reject(new Error(`No JSON in CLI output for: ${args.join(" ")}\nstdout: ${stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(jsonStr) as Record<string, unknown>);
      } catch (e) {
        reject(new Error(`Failed to parse CLI JSON: ${String(e)}\noutput: ${jsonStr.slice(0, 200)}`));
      }
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
