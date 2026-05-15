import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const INDEXER_DIR = path.resolve(ROOT, "../vibly-indexer");
const INDEXER_PROJECT_YAML = path.join(INDEXER_DIR, "project.yaml");
const GRAPHQL_PORT = 3010;
let originalProjectYaml: string | undefined;

export interface IndexerHandle {
  graphqlUrl: string;
}

export async function startIndexer(chainRpcPort: number): Promise<IndexerHandle> {
  const graphqlUrl = `http://127.0.0.1:${GRAPHQL_PORT}/graphql`;

  if (process.env["VIBLY_E2E_EXTERNAL_INDEXER"] === "true") {
    const url =
      process.env["VIBLY_E2E_INDEXER_URL"] ??
      process.env["SUBSTRATE_INDEXER_URL"] ??
      graphqlUrl;
    console.log(`[e2e] External indexer mode — verifying readiness at ${url}`);
    await waitForIndexerReady(url, 30_000);
    return { graphqlUrl: url };
  }

  // Ensure clean state by tearing down any previous run (including volumes).
  console.log("[e2e] Cleaning up previous indexer state…");
  try {
    execSync("docker compose down -v --remove-orphans", { cwd: INDEXER_DIR, stdio: "pipe" });
  } catch {
    // No previous instance — fine.
  }

  await waitForChainHeight(chainRpcPort, 3, 45_000);
  const chainId = process.env["VIBLY_E2E_CHAIN_ID"] ?? "substrate:vibly-solo";
  const genesisHash = await getChainGenesisHash(chainRpcPort);
  // host.docker.internal resolves to the Docker host; the extra_hosts mapping in
  // docker-compose.yml ensures this works on Linux as well.
  const endpoint = `ws://host.docker.internal:${chainRpcPort}`;
  patchIndexerProjectChainId(genesisHash);

  console.log(`[e2e] Starting vibly-indexer (endpoint=${endpoint}, chainId=${chainId}, genesis=${genesisHash})…`);
  try {
    execSync("docker compose up -d", {
      cwd: INDEXER_DIR,
      env: {
        ...process.env,
        ENDPOINT: endpoint,
        CHAIN_ID: chainId,
        START_BLOCK: "1",
      },
      stdio: process.env["VIBLY_E2E_VERBOSE"] === "true" ? "inherit" : "pipe",
    });
  } catch (err) {
    printIndexerLogs();
    restoreIndexerProjectYaml();
    throw new Error(`docker compose up failed: ${String(err)}`);
  }

  try {
    await waitForIndexerReady(graphqlUrl, 180_000);
    console.log(`[e2e] Indexer GraphQL ready at ${graphqlUrl}`);
  } catch (err) {
    printIndexerLogs();
    try {
      execSync("docker compose down -v --remove-orphans", { cwd: INDEXER_DIR, stdio: "pipe" });
    } catch {
      // best-effort cleanup before surfacing readiness failure
    }
    restoreIndexerProjectYaml();
    throw err;
  }

  return { graphqlUrl };
}

/**
 * Poll the GraphQL endpoint until it returns a valid response with no errors.
 * Uses a lightweight `agentStakeLedgers { totalCount }` probe.
 */
export async function waitForIndexerReady(
  graphqlUrl: string,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(graphqlUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "{ agentStakeLedgers { totalCount } }" }),
      });
      if (resp.ok) {
        const body = (await resp.json()) as {
          data?: unknown;
          errors?: { message: string }[];
        };
        if (body.data !== undefined && !body.errors?.length) return;
      }
    } catch {
      // Not ready yet — keep polling.
    }
    await sleep(3_000);
  }
  printIndexerLogs();
  throw new Error(
    `Indexer GraphQL at ${graphqlUrl} did not become ready within ${timeoutMs}ms`,
  );
}

/**
 * Query a single AgentStakeLedger record by agentId.
 * Returns undefined if no matching record exists yet.
 */
export async function queryIndexerLedger(
  graphqlUrl: string,
  agentId: string,
): Promise<IndexerLedger | undefined> {
  const resp = await fetch(graphqlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{
        agentStakeLedgers(filter: { agentId: { equalTo: "${agentId}" } }) {
          nodes {
            id chainId identityId agentId activeAmount unbondingAmount
            status releaseBlocked updatedAtBlock
          }
        }
      }`,
    }),
  });
  const body = (await resp.json()) as {
    data?: { agentStakeLedgers?: { nodes?: IndexerLedger[] } };
  };
  const ledger = body.data?.agentStakeLedgers?.nodes?.[0];
  if (!ledger) return undefined;
  return {
    ...ledger,
    status: normalizeLedgerStatus(ledger.status),
  };
}

export interface IndexerLedger {
  id: string;
  chainId: string;
  identityId: string;
  agentId: string;
  activeAmount: string;
  unbondingAmount: string;
  status: "active" | "unbonding" | "released";
  releaseBlocked: boolean;
  updatedAtBlock: string;
}

function normalizeLedgerStatus(value: string): IndexerLedger["status"] {
  const normalized = value.toLowerCase();
  if (normalized === "active" || normalized === "unbonding" || normalized === "released") {
    return normalized;
  }
  throw new Error(`Unknown AgentStakeLedger status from indexer: ${value}`);
}

export async function stopIndexer(): Promise<void> {
  if (process.env["VIBLY_E2E_EXTERNAL_INDEXER"] === "true") return;
  console.log("[e2e] Stopping indexer…");
  try {
    execSync("docker compose down -v --remove-orphans", { cwd: INDEXER_DIR, stdio: "pipe" });
    restoreIndexerProjectYaml();
    console.log("[e2e] Indexer stopped");
  } catch (err) {
    restoreIndexerProjectYaml();
    console.warn(`[e2e] Warning: failed to stop indexer: ${String(err)}`);
  }
}

async function waitForChainHeight(chainRpcPort: number, minHeight: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${chainRpcPort}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const height = await getChainHeight(url).catch(() => undefined);
    if (height !== undefined && height >= minHeight) return;
    await sleep(1_000);
  }
  throw new Error(`Chain did not reach block ${minHeight} within ${timeoutMs}ms`);
}

async function getChainHeight(url: string): Promise<number> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "chain_getHeader",
      params: [],
    }),
  });
  if (!response.ok) throw new Error(`chain_getHeader failed: HTTP ${response.status}`);
  const body = await response.json() as { result?: { number?: string } };
  const raw = body.result?.number;
  if (!raw) throw new Error("chain_getHeader returned no block number");
  return Number.parseInt(raw, 16);
}

async function getChainGenesisHash(chainRpcPort: number): Promise<string> {
  const url = `http://127.0.0.1:${chainRpcPort}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "chain_getBlockHash",
      params: [0],
    }),
  });
  if (!response.ok) throw new Error(`Unable to read chain genesis hash: HTTP ${response.status}`);
  const body = await response.json() as { result?: string; error?: unknown };
  if (!body.result) throw new Error(`Unable to read chain genesis hash: ${JSON.stringify(body.error ?? body)}`);
  return body.result;
}

function patchIndexerProjectChainId(genesisHash: string): void {
  const current = readFileSync(INDEXER_PROJECT_YAML, "utf8");
  if (originalProjectYaml === undefined) originalProjectYaml = current;
  const next = current.replace(
    /(\n\s*chainId:\s*)['"][^'"]+['"]/,
    `$1'${genesisHash}'`,
  ).replace(
    /\n\s*- kind: substrate\/BlockHandler\n\s*handler: handleBlock\n\s*filter:\n\s*modulo: \d+\n?/,
    "\n",
  );
  if (next === current && !current.includes(genesisHash)) {
    throw new Error(`Unable to patch ${INDEXER_PROJECT_YAML}: network.chainId not found`);
  }
  if (next !== current) writeFileSync(INDEXER_PROJECT_YAML, next);
}

function restoreIndexerProjectYaml(): void {
  if (originalProjectYaml === undefined) return;
  writeFileSync(INDEXER_PROJECT_YAML, originalProjectYaml);
  originalProjectYaml = undefined;
}

function printIndexerLogs(): void {
  try {
    const logs = execSync("docker compose logs --tail=80 2>&1", {
      cwd: INDEXER_DIR,
    }).toString();
    process.stderr.write(`[e2e] Indexer logs:\n${logs}\n`);
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
