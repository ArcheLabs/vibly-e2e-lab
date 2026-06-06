import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import YAML from "yaml";
import { assertPortAvailable } from "./lifecycle/ports.js";
import { startSoloNode, stopSoloNode, type SoloNodeHandle } from "./lifecycle/soloNode.js";
import {
  consoleLaunchArgs,
  consoleLaunchMode,
  consoleStartTimeoutMs,
  prepareConsoleLaunch,
  waitForHttpWithChild,
  withConsoleDevEnv,
} from "./lifecycle/consoleDev.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const COORDINATOR_DIR = path.resolve(ROOT, "../vibly-coordinator");
const DATA_DIR = path.join(ROOT, "data");
const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const CONSOLE_PORT = Number(process.env.VIBLY_E2E_CONSOLE_PORT ?? "3001");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? `http://127.0.0.1:${COORDINATOR_PORT}`;
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";
const LOCAL_GET_VIB_ROOT_UPLOAD_INTERVAL_MS = "120000";
const LOCAL_GET_VIB_ROOT_PUBLISHER_URI = "//Alice";
const COORDINATOR_ENV_FILE = process.env.VIBLY_E2E_COORDINATOR_ENV_FILE
  ?? path.join(COORDINATOR_DIR, "cloud-run.env.yaml");
const NETWORK_MANIFEST_SOURCE = process.env.VIBLY_E2E_NETWORK_MANIFEST_FILE
  ?? path.join(COORDINATOR_DIR, "network-manifest.production.json");
const RUNTIME_MANIFEST_FILE = path.join(DATA_DIR, "get-vib-paseo-network-manifest.json");
const DB_PATH = path.join(DATA_DIR, "get-vib-paseo-console.sqlite");
const PUBLIC_CONSOLE_URL = process.env.VIBLY_E2E_PUBLIC_CONSOLE_URL
  ?? (process.env.VIBLY_E2E_PUBLIC_CONSOLE_PORT
    ? `http://127.0.0.1:${process.env.VIBLY_E2E_PUBLIC_CONSOLE_PORT}`
    : `http://127.0.0.1:${CONSOLE_PORT}`);

const children: ChildProcessWithoutNullStreams[] = [];

type JsonRecord = Record<string, unknown>;

interface RuntimeNetwork {
  id: string;
  label: string;
  status?: string;
  features?: Record<string, boolean>;
  coordinatorUrls?: string[];
  messages?: Record<string, string>;
  chains?: {
    payment?: {
      chainId?: string;
      rpcUrls?: string[];
      tokenSymbol?: string;
      tokenDecimals?: number;
    };
    vibly?: {
      rpcUrls?: string[];
      status?: string;
      tokenSymbol?: string;
      tokenDecimals?: number;
    };
  };
}

async function main(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const coordinatorEnv = await readCloudRunEnv(COORDINATOR_ENV_FILE);
  let vibly: SoloNodeHandle | undefined;
  let coordinator: ChildProcessWithoutNullStreams | undefined;
  let consoleProcess: ChildProcessWithoutNullStreams | undefined;
  try {
    const viblyPlan = await resolveViblyRpcPlan();
    vibly = viblyPlan.localNode;
    const manifest = await buildRuntimeManifest(NETWORK_MANIFEST_SOURCE, viblyPlan.rpcUrls);
    const active = selectActiveNetwork(manifest);
    const paymentRpcUrl = normalizeWsUrl(firstString(active.chains?.payment?.rpcUrls) ?? coordinatorEnv.GET_VIB_RELAY_RPC_URL ?? "");
    const viblyRpcUrl = firstString(active.chains?.vibly?.rpcUrls) ?? "";
    if (!paymentRpcUrl) throw new Error(`Selected network ${active.id} does not define a Paseo payment RPC URL.`);

    const relayStartBlock = await resolveRelayStartBlock(paymentRpcUrl);

    coordinator = await startCoordinator({
      coordinatorEnv,
      active,
      paymentRpcUrl,
      viblyRpcUrl,
      localViblyChain: Boolean(vibly),
      relayStartBlock,
    });
    consoleProcess = await startConsole({
      active,
      paymentRpcUrl,
      viblyRpcUrl,
      profilesJson: JSON.stringify(manifest),
      coordinatorProfilesJson: JSON.stringify(manifest.map((network) => ({
        id: network.id,
        coordinatorUrl: COORDINATOR_URL,
        apiToken: API_TOKEN,
      }))),
    });
    printReady({ active, paymentRpcUrl, localViblyChain: Boolean(vibly), relayStartBlock });
    await waitForShutdownSignal();
  } finally {
    consoleProcess?.kill("SIGTERM");
    coordinator?.kill("SIGTERM");
    await stopChildren();
    if (vibly) await stopSoloNode(vibly);
  }
}

async function readCloudRunEnv(file: string): Promise<Record<string, string>> {
  const parsed = YAML.parse(await readFile(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Coordinator env file must be a YAML object: ${file}`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as JsonRecord)) {
    if (value == null) continue;
    env[key] = String(value);
  }
  return env;
}

async function buildRuntimeManifest(file: string, viblyRpcUrls: string[]): Promise<RuntimeNetwork[]> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Network manifest must be a JSON array: ${file}`);
  const manifest = parsed.map((item) => normalizeNetwork(item)).filter((item): item is RuntimeNetwork => Boolean(item));
  if (!manifest.length) throw new Error(`Network manifest has no valid networks: ${file}`);
  const rewritten = manifest.map((network) => rewriteRuntimeNetwork(network, viblyRpcUrls));
  await writeFile(RUNTIME_MANIFEST_FILE, `${JSON.stringify(rewritten)}\n`);
  return rewritten;
}

async function resolveViblyRpcPlan(): Promise<{ rpcUrls: string[]; localNode?: SoloNodeHandle }> {
  const rawUrls = splitCsv(process.env.VIBLY_E2E_VIBLY_RPC_URLS);
  const localRequested =
    process.env.VIBLY_E2E_LOCAL_VIBLY_CHAIN === "true"
    || process.env.VIBLY_E2E_START_VIBLY_CHAIN === "true"
    || rawUrls.some((url) => url === "local")
    || (rawUrls.some(isLoopbackWsUrl) && process.env.VIBLY_E2E_EXTERNAL_VIBLY_CHAIN !== "true");

  if (!localRequested) {
    return { rpcUrls: rawUrls.map(normalizeWsUrl).filter((url) => url !== "local") };
  }

  const requestedLocalUrl = rawUrls.find(isLoopbackWsUrl);
  const rpcPort = requestedLocalUrl ? Number(new URL(normalizeWsUrl(requestedLocalUrl)).port || "9944") : undefined;
  const localNode = await startSoloNode({ rpcPort, rpcExternal: true, serviceName: "Vibly chain" });
  await initializeLocalGetVibClaimChain(localNode.wsUrl);
  const remoteUrls = rawUrls.filter((url) => url !== "local" && !isLoopbackWsUrl(url)).map(normalizeWsUrl);
  return { rpcUrls: [localNode.wsUrl, ...remoteUrls], localNode };
}

function rewriteRuntimeNetwork(network: RuntimeNetwork, explicitViblyRpcUrls: string[]): RuntimeNetwork {
  const paymentChainId = network.chains?.payment?.chainId;
  if (paymentChainId !== "paseo") return { ...network, coordinatorUrls: [COORDINATOR_URL] };
  const vibly = network.chains?.vibly ?? {};
  const hasExplicitVibly = explicitViblyRpcUrls.length > 0;
  return {
    ...network,
    coordinatorUrls: [COORDINATOR_URL],
    chains: {
      ...network.chains,
      vibly: {
        ...vibly,
        rpcUrls: hasExplicitVibly ? explicitViblyRpcUrls : [],
        status: hasExplicitVibly ? vibly.status ?? "online" : "prelaunch",
      },
    },
    features: {
      ...network.features,
      getVibConversion: true,
      getVibClaim: hasExplicitVibly && network.features?.getVibClaim === true,
      rootIdentityRegistration: hasExplicitVibly && network.features?.rootIdentityRegistration === true,
      staking: hasExplicitVibly && network.features?.staking === true,
      rewards: hasExplicitVibly && network.features?.rewards === true,
    },
    messages: {
      ...(network.messages ?? {}),
      getVibClaim: hasExplicitVibly
        ? network.messages?.getVibClaim ?? ""
        : "VIB claim is disabled in the local Paseo conversion lab. Set VIBLY_E2E_VIBLY_RPC_URLS to test against a Vibly chain.",
    },
  };
}

function normalizeNetwork(value: unknown): RuntimeNetwork | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as RuntimeNetwork & JsonRecord;
  if (typeof record.id !== "string" || typeof record.label !== "string") return undefined;
  return record;
}

function selectActiveNetwork(manifest: RuntimeNetwork[]): RuntimeNetwork {
  const requested = process.env.VIBLY_E2E_NETWORK_ID?.trim();
  const selected = requested
    ? manifest.find((network) => network.id === requested)
    : manifest.find((network) => network.chains?.payment?.chainId === "paseo") ?? manifest[0];
  if (!selected) throw new Error(`Could not find VIBLY_E2E_NETWORK_ID=${requested ?? "<paseo default>"} in manifest.`);
  if (selected.chains?.payment?.chainId !== "paseo") {
    throw new Error(`Selected network ${selected.id} is not Paseo-backed. Set VIBLY_E2E_NETWORK_ID to a network whose payment.chainId is paseo.`);
  }
  return selected;
}

async function startCoordinator(input: {
  coordinatorEnv: Record<string, string>;
  active: RuntimeNetwork;
  paymentRpcUrl: string;
  viblyRpcUrl: string;
  localViblyChain: boolean;
  relayStartBlock: number;
}): Promise<ChildProcessWithoutNullStreams> {
  await assertPortAvailable({
    port: COORDINATOR_PORT,
    serviceName: "Paseo Get VIB coordinator",
    portEnv: "VIBLY_E2E_COORDINATOR_PORT",
  });
  await rm(DB_PATH, { force: true });
  await rm(`${DB_PATH}-shm`, { force: true });
  await rm(`${DB_PATH}-wal`, { force: true });

  const corsOrigins = uniqueStrings([
    PUBLIC_CONSOLE_URL,
    `http://127.0.0.1:${CONSOLE_PORT}`,
    `http://localhost:${CONSOLE_PORT}`,
    input.coordinatorEnv.CORS_ALLOWED_ORIGINS,
  ]).join(",");

  const child = spawn("pnpm", ["--dir", COORDINATOR_DIR, "dev"], {
    env: {
      ...process.env,
      ...input.coordinatorEnv,
      NODE_ENV: process.env.VIBLY_E2E_COORDINATOR_NODE_ENV ?? "development",
      PORT: String(COORDINATOR_PORT),
      HOST: "127.0.0.1",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
      API_AUTH_MODE: "static-token",
      API_TOKENS: API_TOKEN,
      STORAGE_MODE: "sqlite",
      DATABASE_URL: `file:${DB_PATH}`,
      CORS_ALLOWED_ORIGINS: corsOrigins,
      CLIENT_VERSION_ENFORCEMENT: process.env.CLIENT_VERSION_ENFORCEMENT ?? "false",
      ENABLE_DEV_ROUTES: "true",
      GOVERNANCE_BACKENDS: process.env.GOVERNANCE_BACKENDS ?? "none",
      AGENT_REWARD_ENABLED: "false",
      AGENT_REWARD_SYNC_INTERVAL_MS: "0",
      AGENT_REWARD_SETTLEMENT_INTERVAL_MS: "0",
      AGENT_STAKE_SYNC_INTERVAL_MS: "0",
      CHAIN_AUTHORITY_MODE: "disabled",
      ORG_ADMIN_AUTHORITY_SOURCE: "local",
      NETWORK_MANIFEST_FILE: RUNTIME_MANIFEST_FILE,
      NETWORK_MANIFEST_JSON: "",
      GET_VIB_RELAY_RPC_URL: input.paymentRpcUrl,
      GET_VIB_RELAY_CHAIN_ID: input.active.chains?.payment?.chainId ?? "paseo",
      GET_VIB_RELAY_TOKEN_SYMBOL: input.active.chains?.payment?.tokenSymbol ?? "PAS",
      GET_VIB_RELAY_TOKEN_DECIMALS: String(input.active.chains?.payment?.tokenDecimals ?? 10),
      GET_VIB_DEPOSIT_START_BLOCK: String(input.relayStartBlock),
      GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: process.env.VIBLY_E2E_PASEO_WATCHER === "false"
        ? "0"
        : process.env.GET_VIB_DEPOSIT_SCAN_INTERVAL_MS ?? input.coordinatorEnv.GET_VIB_DEPOSIT_SCAN_INTERVAL_MS ?? "15000",
      GET_VIB_DEPOSIT_FINALITY_BLOCKS: process.env.GET_VIB_DEPOSIT_FINALITY_BLOCKS ?? input.coordinatorEnv.GET_VIB_DEPOSIT_FINALITY_BLOCKS ?? "6",
      GET_VIB_CLAIM_ENABLED: input.viblyRpcUrl
        ? process.env.GET_VIB_CLAIM_ENABLED ?? (input.localViblyChain ? "true" : input.coordinatorEnv.GET_VIB_CLAIM_ENABLED ?? "false")
        : "false",
      GET_VIB_ROOT_UPLOAD_MODE: process.env.GET_VIB_ROOT_UPLOAD_MODE
        ?? (input.localViblyChain ? "unsafe-papi" : input.coordinatorEnv.GET_VIB_ROOT_UPLOAD_MODE ?? "prepare-only"),
      GET_VIB_ROOT_PUBLISHER_URI: process.env.GET_VIB_ROOT_PUBLISHER_URI
        ?? (input.localViblyChain ? LOCAL_GET_VIB_ROOT_PUBLISHER_URI : input.coordinatorEnv.GET_VIB_ROOT_PUBLISHER_URI),
      GET_VIB_ROOT_UPLOAD_INTERVAL_MS: process.env.GET_VIB_ROOT_UPLOAD_INTERVAL_MS
        ?? (input.localViblyChain ? LOCAL_GET_VIB_ROOT_UPLOAD_INTERVAL_MS : input.coordinatorEnv.GET_VIB_ROOT_UPLOAD_INTERVAL_MS ?? "120000"),
      SUBSTRATE_RPC_URL: input.viblyRpcUrl || "ws://127.0.0.1:9944",
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

async function signAndWaitLocal(tx: unknown, signer: unknown, label: string): Promise<void> {
  const submittable = tx as {
    signAndSend: (
      signer: unknown,
      cb: (result: { status: { isInBlock?: boolean; isFinalized?: boolean }; dispatchError?: unknown }) => void,
    ) => Promise<() => void>;
  };
  await new Promise<void>((resolve, reject) => {
    let unsub: (() => void) | undefined;
    submittable.signAndSend(signer, (result) => {
      if (result.dispatchError) {
        unsub?.();
        reject(new Error(`${label} failed: ${String(result.dispatchError)}`));
        return;
      }
      if (result.status.isInBlock || result.status.isFinalized) {
        unsub?.();
        resolve();
      }
    }).then((fn) => {
      unsub = fn;
    }).catch(reject);
  });
}

async function startConsole(input: {
  active: RuntimeNetwork;
  paymentRpcUrl: string;
  viblyRpcUrl: string;
  profilesJson: string;
  coordinatorProfilesJson: string;
}): Promise<ChildProcessWithoutNullStreams> {
  await assertPortAvailable({
    port: CONSOLE_PORT,
    serviceName: "Paseo Get VIB console",
    portEnv: "VIBLY_E2E_CONSOLE_PORT",
  });
  const internalOrigin = `http://127.0.0.1:${CONSOLE_PORT}`;
  const mode = consoleLaunchMode("production");
  const consoleEnv = withConsoleDevEnv({
      ...process.env,
      COORDINATOR_URL,
      NEXT_PUBLIC_COORDINATOR_URL: COORDINATOR_URL,
      COORDINATOR_API_TOKEN: API_TOKEN,
      AUTH_URL: PUBLIC_CONSOLE_URL,
      NEXTAUTH_URL: PUBLIC_CONSOLE_URL,
      AUTH_SECRET: "vibly-e2e-paseo-console-secret",
      AUTH_DEV_CREDENTIALS: "true",
      NEXT_PUBLIC_COORDINATOR_TRANSPORT: "proxy",
      NEXT_PUBLIC_VIBLY_NETWORK_ID: input.active.id,
      NEXT_PUBLIC_VIBLY_NETWORK_NAME: input.active.label,
      NEXT_PUBLIC_VIBLY_RPC_URL: input.viblyRpcUrl,
      NEXT_PUBLIC_PAYMENT_RPC_URL: input.paymentRpcUrl,
      NEXT_PUBLIC_POLKADOT_RPC_URL: input.paymentRpcUrl,
      NEXT_PUBLIC_VIBLY_NETWORK_PROFILES: input.profilesJson,
      VIBLY_COORDINATOR_NETWORK_PROFILES: input.coordinatorProfilesJson,
      PORT: String(CONSOLE_PORT),
  });
  await prepareConsoleLaunch(ROOT, consoleEnv, mode);
  const child = spawn("pnpm", consoleLaunchArgs(ROOT, CONSOLE_PORT, mode), {
    env: consoleEnv,
    stdio: "pipe",
  });
  pipeChild("console", child);
  children.push(child);
  await waitForHttpWithChild(`${internalOrigin}/get-vib`, consoleStartTimeoutMs(), child);
  return child;
}

async function resolveRelayStartBlock(paymentRpcUrl: string): Promise<number> {
  const explicit = process.env.VIBLY_E2E_PASEO_START_BLOCK;
  if (explicit && Number.isFinite(Number(explicit))) return Number(explicit);
  if (process.env.VIBLY_E2E_PASEO_WATCHER === "false") return 0;
  const lookback = Number(process.env.VIBLY_E2E_PASEO_LOOKBACK_BLOCKS ?? "20");
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const api = await ApiPromise.create({ provider: new WsProvider(paymentRpcUrl) });
  try {
    const finalizedHash = await api.rpc.chain.getFinalizedHead();
    const header = await api.rpc.chain.getHeader(finalizedHash);
    return Math.max(0, Number(header.number.toString()) - Math.max(0, lookback));
  } finally {
    await api.disconnect();
  }
}

function normalizeWsUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return trimmed;
}

function firstString(values: unknown): string | undefined {
  return Array.isArray(values) ? values.find((item): item is string => typeof item === "string" && item.trim().length > 0) : undefined;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isLoopbackWsUrl(value: string): boolean {
  const normalized = normalizeWsUrl(value);
  if (normalized === "local") return false;
  try {
    const url = new URL(normalized);
    return (url.protocol === "ws:" || url.protocol === "wss:")
      && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.flatMap((value) => (value ?? "").split(",")).map((value) => value.trim()).filter(Boolean))];
}

function printReady(input: { active: RuntimeNetwork; paymentRpcUrl: string; localViblyChain: boolean; relayStartBlock: number }): void {
  const internalConsoleUrl = `http://127.0.0.1:${CONSOLE_PORT}`;
  console.log("");
  console.log("[get-vib:paseo] Ready for production-like Paseo Console validation.");
  console.log(`[get-vib:paseo] Network: ${input.active.label} (${input.active.id})`);
  console.log(`[get-vib:paseo] Console: ${PUBLIC_CONSOLE_URL}`);
  console.log(`[get-vib:paseo] Get VIB: ${PUBLIC_CONSOLE_URL}/get-vib`);
  if (PUBLIC_CONSOLE_URL !== internalConsoleUrl) {
    console.log(`[get-vib:paseo] Console (remote/internal): ${internalConsoleUrl}`);
  }
  console.log(`[get-vib:paseo] Coordinator: ${COORDINATOR_URL}`);
  console.log(`[get-vib:paseo] Paseo RPC: ${input.paymentRpcUrl}`);
  console.log(`[get-vib:paseo] Vibly RPC: ${firstString(input.active.chains?.vibly?.rpcUrls) ?? "disabled (conversion-only lab)"}`);
  console.log(`[get-vib:paseo] Local Vibly chain: ${input.localViblyChain ? "started" : "not managed"}`);
  console.log(`[get-vib:paseo] Relay watcher start block: ${input.relayStartBlock}`);
  console.log(`[get-vib:paseo] Runtime manifest: ${RUNTIME_MANIFEST_FILE}`);
  console.log("[get-vib:paseo] No local payment chain, Playwright tests, or agent daemons are running.");
  console.log("[get-vib:paseo] Press Ctrl+C when finished; cleanup will stop local processes.");
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

main().catch((cause) => {
  console.error(cause);
  process.exit(1);
});
