import { execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const INDEXER_DIR = path.resolve(ROOT, "../vibly-indexer");
const GRAPHQL_PORT = 3010;

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

  const chainId = process.env["VIBLY_E2E_CHAIN_ID"] ?? "substrate:vibly-solo";
  // host.docker.internal resolves to the Docker host; the extra_hosts mapping in
  // docker-compose.yml ensures this works on Linux as well.
  const endpoint = `ws://host.docker.internal:${chainRpcPort}`;

  console.log(`[e2e] Starting vibly-indexer (endpoint=${endpoint}, chainId=${chainId})…`);
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
    throw new Error(`docker compose up failed: ${String(err)}`);
  }

  try {
    await waitForIndexerReady(graphqlUrl, 180_000);
    console.log(`[e2e] Indexer GraphQL ready at ${graphqlUrl}`);
  } catch (err) {
    printIndexerLogs();
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
  return body.data?.agentStakeLedgers?.nodes?.[0];
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

export async function stopIndexer(): Promise<void> {
  if (process.env["VIBLY_E2E_EXTERNAL_INDEXER"] === "true") return;
  console.log("[e2e] Stopping indexer…");
  try {
    execSync("docker compose down -v --remove-orphans", { cwd: INDEXER_DIR, stdio: "pipe" });
    console.log("[e2e] Indexer stopped");
  } catch (err) {
    console.warn(`[e2e] Warning: failed to stop indexer: ${String(err)}`);
  }
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
