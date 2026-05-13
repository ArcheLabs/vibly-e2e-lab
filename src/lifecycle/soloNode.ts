import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_CHAIN_RPC_PORT = 9944;

export interface SoloNodeOptions {
  rpcPort?: number;
  /** Expose RPC to all interfaces (needed when Docker indexer accesses host chain). */
  rpcExternal?: boolean;
}

export interface SoloNodeHandle {
  child: ChildProcessWithoutNullStreams;
  rpcPort: number;
  wsUrl: string;
}

function findSoloNodeBin(): string | null {
  const envBin = process.env["VIBLY_SOLO_NODE_BIN"];
  if (envBin) return envBin;
  const release = path.resolve(ROOT, "../vibly-chain/target/release/vibly-solo-node");
  if (existsSync(release)) return release;
  const debug = path.resolve(ROOT, "../vibly-chain/target/debug/vibly-solo-node");
  if (existsSync(debug)) return debug;
  return null;
}

async function buildSoloNode(): Promise<void> {
  const chainDir = path.resolve(ROOT, "../vibly-chain");
  console.log("[e2e] Running: cargo build -p vibly-solo-node …");
  execSync("cargo build -p vibly-solo-node", { cwd: chainDir, stdio: "inherit" });
}

export async function startSoloNode(opts: SoloNodeOptions = {}): Promise<SoloNodeHandle> {
  const rpcPort = opts.rpcPort ?? Number(process.env["VIBLY_E2E_CHAIN_RPC_PORT"] ?? DEFAULT_CHAIN_RPC_PORT);
  const wsUrl = `ws://127.0.0.1:${rpcPort}`;

  if (process.env["VIBLY_E2E_EXTERNAL_CHAIN"] === "true") {
    console.log(`[e2e] External chain mode — verifying readiness at ${wsUrl}`);
    await waitForChainReady(wsUrl, 30_000);
    return { child: makeFakeChild(), rpcPort, wsUrl };
  }

  let bin = findSoloNodeBin();
  if (!bin) {
    if (process.env["VIBLY_E2E_BUILD_CHAIN"] === "true") {
      await buildSoloNode();
      bin = findSoloNodeBin();
    }
    if (!bin) {
      throw new Error(
        [
          "vibly-solo-node binary not found.",
          "  Build it with: cd ../vibly-chain && cargo build -p vibly-solo-node",
          "  Or point to an existing binary: VIBLY_SOLO_NODE_BIN=/path/to/vibly-solo-node",
          "  Or let the runner build it automatically: VIBLY_E2E_BUILD_CHAIN=true",
        ].join("\n"),
      );
    }
  }

  const args: string[] = ["--dev", "--tmp", "--rpc-port", String(rpcPort)];
  if (opts.rpcExternal) args.push("--rpc-external");

  console.log(`[e2e] Starting vibly-solo-node (port=${rpcPort})…`);
  const child = spawn(bin, args, { env: { ...process.env }, stdio: "pipe" });

  child.stdout.on("data", (chunk: Buffer) => {
    if (process.env["VIBLY_E2E_VERBOSE"] === "true")
      process.stdout.write(`[chain] ${String(chunk)}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (process.env["VIBLY_E2E_VERBOSE"] === "true")
      process.stderr.write(`[chain] ${String(chunk)}`);
  });

  try {
    await waitForChainReady(wsUrl, 60_000);
    console.log(`[e2e] Chain ready at ${wsUrl}`);
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  }

  return { child, rpcPort, wsUrl };
}

/**
 * Wait until the node responds to a `system_health` JSON-RPC call over HTTP.
 * Substrate nodes accept HTTP on the same port as WS.
 */
export async function waitForChainReady(wsUrl: string, timeoutMs = 30_000): Promise<void> {
  // Substrate accepts JSON-RPC over plain HTTP on the same port.
  const httpUrl = wsUrl.replace(/^ws:\/\//, "http://").replace(/^wss:\/\//, "https://");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(httpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "system_health", params: [] }),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { result?: unknown };
        if (body.result !== undefined) return;
      }
    } catch {
      // node not up yet — keep polling
    }
    await sleep(500);
  }
  throw new Error(`Chain at ${wsUrl} did not become ready within ${timeoutMs}ms`);
}

export async function stopSoloNode(handle: SoloNodeHandle, gracePeriodMs = 5_000): Promise<void> {
  const { child } = handle;
  if (child === makeFakeChild()) return; // external mode — nothing to stop
  if (!child.pid) return;

  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, gracePeriodMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  console.log("[e2e] Chain node stopped");
}

let _fakeChild: ChildProcessWithoutNullStreams | undefined;
function makeFakeChild(): ChildProcessWithoutNullStreams {
  if (!_fakeChild) {
    _fakeChild = {
      kill: () => true,
      pid: undefined,
      stdout: { on: () => _fakeChild },
      stderr: { on: () => _fakeChild },
    } as unknown as ChildProcessWithoutNullStreams;
  }
  return _fakeChild;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
