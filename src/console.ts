import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { assertPortAvailable } from "./lifecycle/ports.js";
import { startSoloNode, stopSoloNode, type SoloNodeHandle } from "./lifecycle/soloNode.js";
import { localNetworkProfile, publicConsoleNetworkProfiles, serverCoordinatorNetworkProfiles } from "./lifecycle/networkProfiles.js";
import {
  consoleStartTimeoutMs,
  resetConsoleDevCache,
  waitForHttpWithChild,
  withConsoleDevEnv,
} from "./lifecycle/consoleDev.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const CONSOLE_PORT = Number(process.env.VIBLY_E2E_CONSOLE_PORT ?? "3001");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? `http://127.0.0.1:${COORDINATOR_PORT}`;
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";

const children: ChildProcessWithoutNullStreams[] = [];

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const vibly = await startSoloNode({ rpcExternal: true, serviceName: "Vibly chain" });
  const profile = localNetworkProfile({ coordinatorUrl: COORDINATOR_URL, viblyRpcUrl: vibly.wsUrl });
  const coordinator = await startCoordinator();
  const consoleProcess = await startConsole({
    profilesJson: publicConsoleNetworkProfiles(profile),
    coordinatorProfilesJson: serverCoordinatorNetworkProfiles(profile),
    viblyRpcUrl: profile.viblyRpcUrls[0] ?? vibly.wsUrl,
    networkId: profile.id,
    networkName: profile.label,
  });

  try {
    await runPlaywright();
  } finally {
    consoleProcess.kill("SIGTERM");
    coordinator.kill("SIGTERM");
    await stopChildren();
    await stopOptionalNode(vibly);
  }
}

async function startCoordinator(): Promise<ChildProcessWithoutNullStreams> {
  await assertPortAvailable({
    port: COORDINATOR_PORT,
    serviceName: "Console E2E coordinator",
    portEnv: "VIBLY_E2E_COORDINATOR_PORT",
    externalModeEnv: "VIBLY_E2E_EXTERNAL_COORDINATOR",
  });
  const dbPath = path.join(DATA_DIR, "console-e2e-coordinator.sqlite");
  await rm(dbPath, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  await rm(`${dbPath}-wal`, { force: true });

  const child = spawn("pnpm", ["--dir", path.resolve(ROOT, "../vibly-coordinator"), "dev"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(COORDINATOR_PORT),
      HOST: "127.0.0.1",
      API_AUTH_MODE: "static-token",
      API_TOKENS: API_TOKEN,
      STORAGE_MODE: "sqlite",
      DATABASE_URL: `file:${dbPath}`,
      ENABLE_DEV_ROUTES: "true",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      GOVERNANCE_BACKENDS: "none",
    },
    stdio: "pipe",
  });
  pipeChild("coordinator", child);
  children.push(child);
  await waitForHttp(`${COORDINATOR_URL}/health`, 120_000);
  return child;
}

async function startConsole(input: {
  profilesJson: string;
  coordinatorProfilesJson: string;
  viblyRpcUrl: string;
  networkId: string;
  networkName: string;
}): Promise<ChildProcessWithoutNullStreams> {
  await assertPortAvailable({
    port: CONSOLE_PORT,
    serviceName: "Console E2E console",
    portEnv: "VIBLY_E2E_CONSOLE_PORT",
  });
  const origin = `http://127.0.0.1:${CONSOLE_PORT}`;
  await resetConsoleDevCache(ROOT);
  const child = spawn("pnpm", ["--dir", path.resolve(ROOT, "../vibly-console"), "exec", "next", "dev", "--webpack", "-p", String(CONSOLE_PORT)], {
    env: withConsoleDevEnv({
      ...process.env,
      COORDINATOR_URL,
      NEXT_PUBLIC_COORDINATOR_URL: COORDINATOR_URL,
      COORDINATOR_API_TOKEN: API_TOKEN,
      AUTH_URL: origin,
      NEXTAUTH_URL: origin,
      AUTH_SECRET: "vibly-e2e-console-secret",
      AUTH_DEV_CREDENTIALS: "true",
      NEXT_PUBLIC_VIBLY_NETWORK_ID: input.networkId,
      NEXT_PUBLIC_VIBLY_NETWORK_NAME: input.networkName,
      NEXT_PUBLIC_VIBLY_RPC_URL: input.viblyRpcUrl,
      NEXT_PUBLIC_POLKADOT_RPC_URL: input.viblyRpcUrl,
      NEXT_PUBLIC_VIBLY_NETWORK_PROFILES: input.profilesJson,
      VIBLY_COORDINATOR_NETWORK_PROFILES: input.coordinatorProfilesJson,
      PORT: String(CONSOLE_PORT),
    }),
    stdio: "pipe",
  });
  pipeChild("console", child);
  children.push(child);
  await waitForHttpWithChild(`${origin}/personal-center`, consoleStartTimeoutMs(), child);
  return child;
}

async function runPlaywright(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "playwright", "test"], { cwd: ROOT, env: { ...process.env }, stdio: "inherit" });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Playwright exited with code ${String(code)}`));
    });
    child.once("error", reject);
  });
}

function pipeChild(name: string, child: ChildProcessWithoutNullStreams): void {
  child.stdout.on("data", (chunk: Buffer) => {
    if (process.env.VIBLY_E2E_VERBOSE === "true") process.stdout.write(`[${name}] ${String(chunk)}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (process.env.VIBLY_E2E_VERBOSE === "true") process.stderr.write(`[${name}] ${String(chunk)}`);
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(url).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChildren(): Promise<void> {
  for (const child of children.splice(0)) {
    if (!child.pid) continue;
    child.kill("SIGTERM");
  }
}

async function stopOptionalNode(handle: SoloNodeHandle | undefined): Promise<void> {
  if (handle) await stopSoloNode(handle);
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
