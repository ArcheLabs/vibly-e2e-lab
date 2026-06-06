import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONSOLE_START_TIMEOUT_MS = 240_000;
export type ConsoleLaunchMode = "dev" | "production";

export function consoleStartTimeoutMs(): number {
  return Number(process.env.VIBLY_E2E_CONSOLE_START_TIMEOUT_MS ?? DEFAULT_CONSOLE_START_TIMEOUT_MS);
}

export function withConsoleDevEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    WATCHPACK_POLLING: env.WATCHPACK_POLLING ?? "true",
    CHOKIDAR_USEPOLLING: env.CHOKIDAR_USEPOLLING ?? "true",
  };
}

export function consoleLaunchMode(defaultMode: ConsoleLaunchMode = "dev"): ConsoleLaunchMode {
  const raw = process.env.VIBLY_E2E_CONSOLE_MODE?.trim().toLowerCase();
  if (raw === "production" || raw === "prod" || raw === "start") return "production";
  if (raw === "dev" || raw === "development") return "dev";
  return defaultMode;
}

export async function prepareConsoleLaunch(root: string, env: NodeJS.ProcessEnv, mode: ConsoleLaunchMode): Promise<void> {
  if (mode === "dev") {
    await resetConsoleDevCache(root);
    return;
  }
  await runConsoleCommand(root, ["build"], env, "Console production build");
}

export function consoleLaunchArgs(root: string, port: number, mode: ConsoleLaunchMode): string[] {
  const consoleDir = path.resolve(root, "../vibly-console");
  if (mode === "production") return ["--dir", consoleDir, "exec", "next", "start", "-p", String(port)];
  return ["--dir", consoleDir, "exec", "next", "dev", "--webpack", "-p", String(port)];
}

export async function resetConsoleDevCache(root: string): Promise<void> {
  if (process.env.VIBLY_E2E_KEEP_CONSOLE_CACHE === "true") return;
  await rm(path.resolve(root, "../vibly-console/.next/dev"), { recursive: true, force: true });
}

async function runConsoleCommand(root: string, args: string[], env: NodeJS.ProcessEnv, label: string): Promise<void> {
  const child = spawn("pnpm", ["--dir", path.resolve(root, "../vibly-console"), ...args], {
    env,
    stdio: process.env.VIBLY_E2E_VERBOSE === "true" ? "inherit" : "pipe",
  });
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} failed (code=${String(code)}, signal=${String(signal)}): ${stderr.trim()}`));
    });
  });
}

export async function waitForHttpWithChild(
  url: string,
  timeoutMs: number,
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  let childFailure: Error | undefined;
  child.once("exit", (code, signal) => {
    childFailure = new Error(`Console process exited before ${url} became ready (code=${String(code)}, signal=${String(signal)})`);
  });
  child.once("error", (error) => {
    childFailure = error;
  });

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (childFailure) throw childFailure;
    const response = await fetch(url).catch((error) => {
      lastError = error;
      return undefined;
    });
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const details = lastError ? ` Last fetch error: ${String(lastError)}` : "";
  throw new Error(`Timed out waiting ${timeoutMs}ms for Console at ${url}.${details}`);
}
