/**
 * e2e:stop — forcefully terminate all services started by the e2e runner.
 *
 * Usage:  pnpm e2e:stop
 *
 * Stops (in order):
 *   1. Coordinator process         (kills whatever is listening on COORDINATOR_PORT)
 *   2. Console process             (kills whatever is listening on CONSOLE_PORT)
 *   3. Chain node                  (kills whatever is listening on CHAIN_RPC_PORT +
 *                                   any remaining vibly-solo-node process)
 *   4. Agent daemons               (kills processes matching "daemon start --interval")
 *   5. Docker indexer containers   (docker compose down --remove-orphans)
 *
 * Docker volumes are intentionally preserved so that the next run starts with a
 * clean indexer rather than needing to download chain data again.
 * To also wipe volumes: pnpm e2e:stop -- --volumes
 */

import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const INDEXER_DIR = path.resolve(ROOT, "../vibly-indexer");

const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const CONSOLE_PORT = Number(process.env.VIBLY_E2E_CONSOLE_PORT ?? "3001");
const CHAIN_RPC_PORT = Number(process.env.VIBLY_E2E_CHAIN_RPC_PORT ?? "9944");
const PAYMENT_CHAIN_RPC_PORT = Number(process.env.VIBLY_E2E_PAYMENT_CHAIN_RPC_PORT ?? "9945");
const WIPE_VOLUMES = process.argv.includes("--volumes");

/** Kill all processes listening on the given TCP port (SIGTERM). */
function killPort(port: number, label: string): void {
  // fuser exits non-zero when no process holds the port — that is expected.
  const result = spawnSync("fuser", ["-k", "-TERM", `${port}/tcp`], { stdio: "pipe" });
  if (result.status === 0) {
    console.log(`[e2e:stop] Stopped ${label} (port ${port})`);
  } else {
    console.log(`[e2e:stop] ${label} (port ${port}) — not running`);
  }
}

/** Kill processes whose command line matches the given pattern (SIGTERM). */
function killByPattern(pattern: string, label: string): void {
  // pkill exits non-zero when no matching process exists — that is expected.
  const result = spawnSync("pkill", ["-TERM", "-f", pattern], { stdio: "pipe" });
  if (result.status === 0) {
    console.log(`[e2e:stop] Stopped ${label}`);
  } else {
    console.log(`[e2e:stop] ${label} — not running`);
  }
}

function stopDocker(): void {
  const args = WIPE_VOLUMES
    ? ["compose", "down", "-v", "--remove-orphans"]
    : ["compose", "down", "--remove-orphans"];
  console.log(
    `[e2e:stop] Stopping Docker indexer${WIPE_VOLUMES ? " (+ volumes)" : ""}…`,
  );
  try {
    execSync(`docker ${args.join(" ")}`, { cwd: INDEXER_DIR, stdio: "pipe" });
    console.log("[e2e:stop] Docker indexer stopped");
  } catch {
    console.log("[e2e:stop] Docker indexer — not running or already stopped");
  }
}

function main(): void {
  killPort(COORDINATOR_PORT, "coordinator");
  killPort(CONSOLE_PORT, "console");
  killPort(CHAIN_RPC_PORT, "chain node");
  killPort(PAYMENT_CHAIN_RPC_PORT, "payment chain node");
  // Belt-and-braces: also kill by process name in case the node uses a different port.
  killByPattern("vibly-solo-node", "chain node (process name)");
  // Agent daemons are started with "daemon start --interval <N>"
  killByPattern("daemon start --interval", "agent daemons");
  stopDocker();
  console.log("[e2e:stop] Done.");
}

main();
