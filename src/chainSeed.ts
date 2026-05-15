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
  const sharedSignerOpts = [
    "--rpc-url", input.chainRpcUrl,
    "--signer-uri", rootSignerUri,
    "--chain-id", input.chainId,
    "--json",
  ];

  // ── Step 1: Register identity ─────────────────────────────────────────────
  console.log(`[chain-seed] Registering identity for agent ${input.agentId}…`);
  const identityReceipt = await spawnCliJson<{ identityId?: string }>([
    "agent", "identity", "register-chain",
    ...sharedSignerOpts,
  ]);
  if (!identityReceipt.identityId) {
    throw new Error(`register-identity did not return identityId for agent ${input.agentId}`);
  }
  const identityId = identityReceipt.identityId;
  console.log(`[chain-seed] Identity registered: identityId=${identityId}`);

  // ── Step 2: Register agent on chain ──────────────────────────────────────
  // Derive a deterministic ContentRef hash from the agentId string.
  const agentRefHex = "0x" + createHash("sha256").update(`vibly-e2e-agent:${input.agentId}`).digest("hex");
  console.log(`[chain-seed] Registering chain agent for ${input.agentId} (agentRef=${agentRefHex.slice(0, 12)}…)…`);
  const registerReceipt = await spawnCliJson<{ agentId?: string }>([
    "agent", "register-chain",
    "--identity-id", identityId,
    "--agent-ref", `hash:${agentRefHex}`,
    ...sharedSignerOpts,
  ]);
  if (!registerReceipt.agentId) {
    throw new Error(`register-agent did not return agentId for agent ${input.agentId}`);
  }
  const chainAgentId = registerReceipt.agentId;
  console.log(`[chain-seed] Chain agent registered: chainAgentId=${chainAgentId}`);

  // ── Step 3: Bond stake ────────────────────────────────────────────────────
  console.log(`[chain-seed] Bonding ${bondAmount} for agent ${input.agentId}…`);
  const bondReceipt = await spawnCliJson<{ txHash: string }>([
    "agent", "stake", "bond",
    "--identity-id", identityId,
    "--agent-id", chainAgentId,
    "--amount", bondAmount,
    ...sharedSignerOpts,
  ]);
  console.log(`[chain-seed] Bond tx submitted: txHash=${bondReceipt.txHash}`);

  // ── Step 4: Wait for indexer to reflect the active ledger ─────────────────
  console.log(`[chain-seed] Waiting for indexer ledger (chainAgentId=${chainAgentId.slice(0, 12)}…)…`);
  const indexerLedger = await waitForIndexerActiveLedger(input.graphqlUrl, chainAgentId, 120_000);
  console.log(`[chain-seed] Indexer ledger confirmed active for ${input.agentId}`);

  return {
    agentId: input.agentId,
    identityId,
    chainAgentId,
    bondTxHash: bondReceipt.txHash,
    indexerLedger,
  };
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
      return body.data?.agent?.stakeLedger?.status === "active" ? true : undefined;
    },
    `coordinator stake sync for principalId=${principalId}`,
    timeoutMs,
  );
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
