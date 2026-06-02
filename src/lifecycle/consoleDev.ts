import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_CONSOLE_START_TIMEOUT_MS = 240_000;

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

export async function resetConsoleDevCache(root: string): Promise<void> {
  if (process.env.VIBLY_E2E_KEEP_CONSOLE_CACHE === "true") return;
  await rm(path.resolve(root, "../vibly-console/.next/dev"), { recursive: true, force: true });
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
