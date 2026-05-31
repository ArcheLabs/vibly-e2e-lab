import { spawn, execSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readlinkSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_CHAIN_RPC_PORT = 9944;

export interface SoloNodeOptions {
  rpcPort?: number;
  rpcUrl?: string;
  serviceName?: string;
  /** Expose RPC to all interfaces (needed when Docker indexer accesses host chain). */
  rpcExternal?: boolean;
  external?: boolean;
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

export function hasSoloNodeBinary(): boolean {
  return findSoloNodeBin() !== null;
}

async function buildSoloNode(): Promise<void> {
  const chainDir = path.resolve(ROOT, "../vibly-chain");
  const buildEnv = resolveChainBuildEnv();
  console.log("[e2e] Running: cargo build -p vibly-solo-node …");
  execSync("cargo build -p vibly-solo-node", { cwd: chainDir, env: buildEnv, stdio: "inherit" });
}

function resolveChainBuildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const autoDetected: string[] = [];

  if (!env["LLVM_CONFIG_PATH"]) {
    const llvmConfigPath = findLlvmConfigPath();
    if (llvmConfigPath) {
      env["LLVM_CONFIG_PATH"] = llvmConfigPath;
      autoDetected.push(`LLVM_CONFIG_PATH=${llvmConfigPath}`);
    }
  }

  if (!env["LIBCLANG_PATH"]) {
    const libclangPath = findLibclangPath(env["LLVM_CONFIG_PATH"]);
    if (libclangPath) {
      env["LIBCLANG_PATH"] = libclangPath;
      autoDetected.push(`LIBCLANG_PATH=${libclangPath}`);
    }
  }

  if (autoDetected.length > 0) {
    console.log(`[e2e] Auto-detected chain build env: ${autoDetected.join(", ")}`);
  }

  return env;
}

function findLlvmConfigPath(): string | undefined {
  return findExistingPath([
    "/usr/bin/llvm-config",
    "/usr/lib/llvm-19/bin/llvm-config",
    "/usr/lib/llvm-18/bin/llvm-config",
    "/usr/lib/llvm-17/bin/llvm-config",
    "/usr/lib/llvm-16/bin/llvm-config",
    "/opt/homebrew/opt/llvm/bin/llvm-config",
    "/usr/local/opt/llvm/bin/llvm-config",
  ]);
}

function findLibclangPath(llvmConfigPath: string | undefined): string | undefined {
  const explicitCandidates = new Set<string>();
  const home = process.env["HOME"];
  if (home) explicitCandidates.add(path.join(home, ".local/lib/libclang-compat"));

  for (const dir of llvmLibDirCandidates(llvmConfigPath)) {
    explicitCandidates.add(dir);
  }

  for (const candidate of explicitCandidates) {
    if (hasClangSysCompatibleLib(candidate)) return candidate;
  }

  return ensureLibclangCompatDir(llvmConfigPath);
}

function llvmLibDirCandidates(llvmConfigPath: string | undefined): string[] {
  const candidates = new Set<string>();
  if (llvmConfigPath) {
    candidates.add(path.resolve(path.dirname(llvmConfigPath), "../lib"));
  }
  candidates.add("/usr/lib/llvm-19/lib");
  candidates.add("/usr/lib/llvm-18/lib");
  candidates.add("/usr/lib/llvm-17/lib");
  candidates.add("/usr/lib/llvm-16/lib");
  candidates.add("/usr/local/lib");
  return Array.from(candidates);
}

function hasClangSysCompatibleLib(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((entry) => /^libclang(?:-[^.\/]+)?\.so$/.test(entry));
  } catch {
    return false;
  }
}

function ensureLibclangCompatDir(llvmConfigPath: string | undefined): string | undefined {
  const home = process.env["HOME"];
  if (!home) return undefined;

  const compatDir = path.join(home, ".local/lib/libclang-compat");
  for (const sourceDir of llvmLibDirCandidates(llvmConfigPath)) {
    if (!existsSync(sourceDir)) continue;

    const libclangSo1 = path.join(sourceDir, "libclang.so.1");
    const versioned = findVersionedLibclang(sourceDir);
    if (!existsSync(libclangSo1) && !versioned) continue;

    mkdirSync(compatDir, { recursive: true });
    if (existsSync(libclangSo1)) {
      ensureSymlink(path.join(compatDir, "libclang.so"), libclangSo1);
    }
    if (versioned) {
      ensureSymlink(path.join(compatDir, `libclang-${versioned.major}.so`), versioned.path);
    }

    if (hasClangSysCompatibleLib(compatDir)) return compatDir;
  }

  return undefined;
}

function findVersionedLibclang(dir: string): { major: string; path: string } | undefined {
  try {
    for (const entry of readdirSync(dir)) {
      const match = entry.match(/^libclang-(\d+)\.so(?:\.\d+)*$/);
      if (!match) continue;
      return { major: match[1], path: path.join(dir, entry) };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function ensureSymlink(linkPath: string, targetPath: string): void {
  try {
    if (existsSync(linkPath)) {
      try {
        if (readlinkSync(linkPath) === targetPath) return;
      } catch {
        return;
      }
    }
    symlinkSync(targetPath, linkPath);
  } catch {
    // Best-effort only; cargo will fall back to any explicit env already present.
  }
}

function findExistingPath(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

export async function startSoloNode(opts: SoloNodeOptions = {}): Promise<SoloNodeHandle> {
  const requestedRpcPort = opts.rpcPort ?? Number(process.env["VIBLY_E2E_CHAIN_RPC_PORT"] ?? DEFAULT_CHAIN_RPC_PORT);
  const hasExplicitRpcPort =
    opts.rpcPort !== undefined || process.env["VIBLY_E2E_CHAIN_RPC_PORT"] !== undefined;
  const rpcPort = await resolveRpcPort(requestedRpcPort, hasExplicitRpcPort);
  const wsUrl = opts.rpcUrl ?? `ws://127.0.0.1:${rpcPort}`;
  const serviceName = opts.serviceName ?? "vibly-solo-node";

  if (opts.external === true || process.env["VIBLY_E2E_EXTERNAL_CHAIN"] === "true") {
    console.log(`[e2e] External ${serviceName} mode — verifying readiness at ${wsUrl}`);
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

  const args: string[] = [
    "--dev",
    "--tmp",
    "--rpc-port",
    String(rpcPort),
    "--state-pruning",
    "archive",
    "--blocks-pruning",
    "archive",
  ];
  if (opts.rpcExternal) args.push("--rpc-external");

  console.log(`[e2e] Starting ${serviceName} (port=${rpcPort})…`);
  const child = spawn(bin, args, { env: { ...process.env }, stdio: "pipe" });

  child.stdout.on("data", (chunk: Buffer) => {
    if (process.env["VIBLY_E2E_VERBOSE"] === "true")
      process.stdout.write(`[chain] ${String(chunk)}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (process.env["VIBLY_E2E_VERBOSE"] === "true")
      process.stderr.write(`[chain] ${String(chunk)}`);
  });

  const chainStartTimeoutMs = Number(process.env["VIBLY_E2E_CHAIN_START_TIMEOUT_MS"] ?? 60_000);
  try {
    await waitForChainReady(wsUrl, chainStartTimeoutMs);
    console.log(`[e2e] ${serviceName} ready at ${wsUrl}`);
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

async function resolveRpcPort(requestedPort: number, isExplicit: boolean): Promise<number> {
  if (await isPortAvailable(requestedPort)) return requestedPort;

  if (isExplicit) {
    throw new Error(
      [
        `Requested chain RPC port ${requestedPort} is already in use.`,
        "  Stop the existing node, choose a different VIBLY_E2E_CHAIN_RPC_PORT,",
        "  or set VIBLY_E2E_EXTERNAL_CHAIN=true to attach to an existing chain.",
      ].join("\n"),
    );
  }

  const fallbackPort = await getEphemeralPort();
  console.warn(
    `[e2e] RPC port ${requestedPort} already in use; starting vibly-solo-node on ${fallbackPort} instead`,
  );
  return fallbackPort;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate an ephemeral RPC port for vibly-solo-node"));
        return;
      }

      const { port } = address;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}
