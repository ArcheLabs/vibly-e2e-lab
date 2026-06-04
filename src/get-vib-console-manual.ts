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
const PAYMENT_CHAIN_RPC_PORT = Number(process.env.VIBLY_E2E_PAYMENT_CHAIN_RPC_PORT ?? "9945");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? `http://127.0.0.1:${COORDINATOR_PORT}`;
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";
const LOCAL_GET_VIB_ROOT_UPLOAD_INTERVAL_MS = "120000";
const LOCAL_GET_VIB_ROOT_PUBLISHER_URI = "//Alice";
const PUBLIC_CONSOLE_URL = process.env.VIBLY_E2E_PUBLIC_CONSOLE_URL
  ?? (process.env.VIBLY_E2E_PUBLIC_CONSOLE_PORT
    ? `http://127.0.0.1:${process.env.VIBLY_E2E_PUBLIC_CONSOLE_PORT}`
    : `http://127.0.0.1:${CONSOLE_PORT}`);
const DEPOSIT_ADDRESS = process.env.VIBLY_DOT_RECEIVING_ADDRESS
  ?? process.env.VIBLY_E2E_GET_VIB_DEPOSIT_ADDRESS
  ?? "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

const children: ChildProcessWithoutNullStreams[] = [];

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  let vibly: SoloNodeHandle | undefined;
  let payment: SoloNodeHandle | undefined;
  let coordinator: ChildProcessWithoutNullStreams | undefined;
  let consoleProcess: ChildProcessWithoutNullStreams | undefined;

  try {
    vibly = await startSoloNode({ rpcExternal: true, serviceName: "Vibly chain" });
    payment = await startSoloNode({ rpcPort: PAYMENT_CHAIN_RPC_PORT, rpcExternal: true, serviceName: "payment chain" });
    await initializeLocalGetVibClaimChain(vibly.wsUrl);
    const profile = localNetworkProfile({
      coordinatorUrl: COORDINATOR_URL,
      viblyRpcUrl: vibly.wsUrl,
      paymentRpcUrl: payment.wsUrl,
    });
    coordinator = await startCoordinator({
      paymentRpcUrl: profile.paymentRpcUrls[0] ?? payment.wsUrl,
      viblyRpcUrl: profile.viblyRpcUrls[0] ?? vibly.wsUrl,
    });
    consoleProcess = await startConsole({
      profilesJson: publicConsoleNetworkProfiles(profile),
      coordinatorProfilesJson: serverCoordinatorNetworkProfiles(profile),
      viblyRpcUrl: profile.viblyRpcUrls[0] ?? vibly.wsUrl,
      paymentRpcUrl: profile.paymentRpcUrls[0] ?? payment.wsUrl,
      networkId: profile.id,
      networkName: profile.label,
    });

    printReady();
    await waitForShutdownSignal();
  } finally {
    consoleProcess?.kill("SIGTERM");
    coordinator?.kill("SIGTERM");
    await stopChildren();
    await stopOptionalNode(payment);
    await stopOptionalNode(vibly);
  }
}

async function startCoordinator(input: {
  paymentRpcUrl: string;
  viblyRpcUrl: string;
}): Promise<ChildProcessWithoutNullStreams> {
  await assertPortAvailable({
    port: COORDINATOR_PORT,
    serviceName: "Get VIB manual coordinator",
    portEnv: "VIBLY_E2E_COORDINATOR_PORT",
    externalModeEnv: "VIBLY_E2E_EXTERNAL_COORDINATOR",
  });
  const dbPath = path.join(DATA_DIR, "get-vib-console-manual.sqlite");
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
      VIBLY_DOT_RECEIVING_ADDRESS: DEPOSIT_ADDRESS,
      GET_VIB_RELAY_RPC_URL: input.paymentRpcUrl,
      GET_VIB_RELAY_CHAIN_ID: "polkadot-local",
      GET_VIB_RELAY_TOKEN_SYMBOL: "DOT",
      GET_VIB_RELAY_TOKEN_DECIMALS: "10",
      GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: process.env.GET_VIB_DEPOSIT_SCAN_INTERVAL_MS ?? "1500",
      GET_VIB_DEPOSIT_FINALITY_BLOCKS: process.env.GET_VIB_DEPOSIT_FINALITY_BLOCKS ?? "0",
      GET_VIB_CLAIM_ENABLED: process.env.GET_VIB_CLAIM_ENABLED ?? "true",
      GET_VIB_ROOT_UPLOAD_INTERVAL_MS: process.env.GET_VIB_ROOT_UPLOAD_INTERVAL_MS ?? LOCAL_GET_VIB_ROOT_UPLOAD_INTERVAL_MS,
      GET_VIB_ROOT_UPLOAD_MODE: process.env.GET_VIB_ROOT_UPLOAD_MODE ?? "unsafe-papi",
      GET_VIB_ROOT_PUBLISHER_URI: process.env.GET_VIB_ROOT_PUBLISHER_URI ?? LOCAL_GET_VIB_ROOT_PUBLISHER_URI,
      SUBSTRATE_RPC_URL: process.env.SUBSTRATE_RPC_URL ?? input.viblyRpcUrl,
    },
    stdio: "pipe",
  });
  pipeChild("coordinator", child);
  children.push(child);
  await waitForHttp(`${COORDINATOR_URL}/health`, 120_000);
  return child;
}

async function initializeLocalGetVibClaimChain(rpcUrl: string): Promise<void> {
  const [{ ApiPromise, WsProvider }, { Keyring }, { cryptoWaitReady, encodeAddress }] = await Promise.all([
    import("@polkadot/api"),
    import("@polkadot/keyring"),
    import("@polkadot/util-crypto"),
  ]);
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(rpcUrl) });
  try {
    const keyring = new Keyring({ type: "sr25519" });
    const sudo = keyring.addFromUri("//Alice");
    const publisher = keyring.addFromUri(process.env.GET_VIB_ROOT_PUBLISHER_URI ?? LOCAL_GET_VIB_ROOT_PUBLISHER_URI);
    const reserve = encodeAddress(new Uint8Array(32).fill(7), 42);
    const configuredPublisher = await api.query.vibClaim.claimRootPublisher() as unknown as { isSome?: boolean; unwrap?: () => { toString(): string } };
    const currentPublisher = configuredPublisher.isSome && typeof configuredPublisher.unwrap === "function"
      ? configuredPublisher.unwrap().toString()
      : undefined;
    if (currentPublisher !== publisher.address) {
      await signAndWaitLocal(
        api.tx.sudo.sudo(api.tx.vibClaim.setClaimRootPublisher(publisher.address)),
        sudo,
        "vibClaim.setClaimRootPublisher",
      );
    }

    if (!api.tx.balances.forceSetBalance) return;
    const reserveTarget = 100_000_000n * 10n ** 12n;
    const reserveAccount = await api.query.system.account(reserve) as unknown as { data: { free: { toString(): string } } };
    if (BigInt(reserveAccount.data.free.toString()) < reserveTarget) {
      await signAndWaitLocal(
        api.tx.sudo.sudo(api.tx.balances.forceSetBalance(reserve, reserveTarget)),
        sudo,
        "balances.forceSetBalance",
      );
    }
  } finally {
    await api.disconnect();
  }
}

async function startConsole(input: {
  profilesJson: string;
  coordinatorProfilesJson: string;
  viblyRpcUrl: string;
  paymentRpcUrl: string;
  networkId: string;
  networkName: string;
}): Promise<ChildProcessWithoutNullStreams> {
  await assertPortAvailable({
    port: CONSOLE_PORT,
    serviceName: "Get VIB manual console",
    portEnv: "VIBLY_E2E_CONSOLE_PORT",
  });
  const internalOrigin = `http://127.0.0.1:${CONSOLE_PORT}`;
  await resetConsoleDevCache(ROOT);
  const child = spawn("pnpm", ["--dir", path.resolve(ROOT, "../vibly-console"), "exec", "next", "dev", "--webpack", "-p", String(CONSOLE_PORT)], {
    env: withConsoleDevEnv({
      ...process.env,
      COORDINATOR_URL,
      NEXT_PUBLIC_COORDINATOR_URL: COORDINATOR_URL,
      COORDINATOR_API_TOKEN: API_TOKEN,
      AUTH_URL: PUBLIC_CONSOLE_URL,
      NEXTAUTH_URL: PUBLIC_CONSOLE_URL,
      AUTH_SECRET: "vibly-e2e-console-secret",
      AUTH_DEV_CREDENTIALS: "true",
      NEXT_PUBLIC_VIBLY_NETWORK_ID: input.networkId,
      NEXT_PUBLIC_VIBLY_NETWORK_NAME: input.networkName,
      NEXT_PUBLIC_VIBLY_RPC_URL: input.viblyRpcUrl,
      NEXT_PUBLIC_PAYMENT_RPC_URL: input.paymentRpcUrl,
      NEXT_PUBLIC_POLKADOT_RPC_URL: input.paymentRpcUrl,
      NEXT_PUBLIC_VIBLY_NETWORK_PROFILES: input.profilesJson,
      VIBLY_COORDINATOR_NETWORK_PROFILES: input.coordinatorProfilesJson,
      PORT: String(CONSOLE_PORT),
    }),
    stdio: "pipe",
  });
  pipeChild("console", child);
  children.push(child);
  await waitForHttpWithChild(`${internalOrigin}/get-vib`, consoleStartTimeoutMs(), child);
  return child;
}

function printReady(): void {
  const internalConsoleUrl = `http://127.0.0.1:${CONSOLE_PORT}`;
  console.log("");
  console.log("[get-vib:manual] Ready for manual Console validation.");
  console.log(`[get-vib:manual] Console: ${PUBLIC_CONSOLE_URL}`);
  console.log(`[get-vib:manual] Get VIB: ${PUBLIC_CONSOLE_URL}/get-vib`);
  if (PUBLIC_CONSOLE_URL !== internalConsoleUrl) {
    console.log(`[get-vib:manual] Console (remote/internal): ${internalConsoleUrl}`);
  }
  console.log(`[get-vib:manual] Coordinator: ${COORDINATOR_URL}`);
  console.log(`[get-vib:manual] Deposit address: ${DEPOSIT_ADDRESS}`);
  console.log(`[get-vib:manual] Root upload interval: ${process.env.GET_VIB_ROOT_UPLOAD_INTERVAL_MS ?? LOCAL_GET_VIB_ROOT_UPLOAD_INTERVAL_MS}ms`);
  console.log("[get-vib:manual] No Playwright tests or agent daemons are running.");
  console.log("[get-vib:manual] Press Ctrl+C when finished; cleanup will stop local processes.");
  console.log("");
}

async function waitForShutdownSignal(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
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

async function signAndWaitLocal(
  tx: unknown,
  signer: unknown,
  label: string,
): Promise<void> {
  const submittable = tx as {
    signAndSend: (
      signer: unknown,
      callback: (result: {
        dispatchError?: { toString(): string };
        events?: Array<{ event: { section: string; method: string; data: unknown[] } }>;
        status: { isInBlock: boolean; isFinalized: boolean };
      }) => void,
    ) => Promise<() => void>;
  };
  await new Promise<void>((resolve, reject) => {
    void submittable.signAndSend(signer, (result) => {
      if (result.dispatchError) {
        reject(new Error(`${label}: ${result.dispatchError.toString()}`));
        return;
      }
      const sudoFailed = result.events?.find((item) => item.event.section === "sudo" && item.event.method === "Sudid" && String(item.event.data[0]).startsWith("Err"));
      if (sudoFailed) {
        reject(new Error(`${label}: ${String(sudoFailed.event.data[0])}`));
        return;
      }
      if (result.status.isInBlock || result.status.isFinalized) resolve();
    }).catch(reject);
  });
}

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
