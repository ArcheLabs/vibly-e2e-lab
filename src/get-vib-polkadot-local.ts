import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertPortAvailable } from "./lifecycle/ports.js";
import { startSoloNode, stopSoloNode, type SoloNodeHandle } from "./lifecycle/soloNode.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const REPORT_DIR = path.join(ROOT, "reports");
const COORDINATOR_PORT = Number(process.env.VIBLY_E2E_COORDINATOR_PORT ?? "8787");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";
const RELAY_RPC_URL = process.env.VIBLY_E2E_GET_VIB_RELAY_RPC ?? "ws://127.0.0.1:9945";
const RELAY_SURI = process.env.VIBLY_E2E_GET_VIB_RELAY_SURI ?? "//Alice";
const CHAIN_RPC_URL = process.env.VIBLY_E2E_GET_VIB_CHAIN_RPC ?? "ws://127.0.0.1:9955";
const CLAIM_SURI = process.env.VIBLY_E2E_GET_VIB_CLAIM_SURI ?? "//Alice";
const DOT_AMOUNT = process.env.VIBLY_E2E_GET_VIB_DOT ?? "1";
const DELTA_DOT_AMOUNT = process.env.VIBLY_E2E_GET_VIB_DELTA_DOT ?? "0.5";
const RELAY_TOKEN_DECIMALS = Number(process.env.VIBLY_E2E_GET_VIB_RELAY_DECIMALS ?? "10");
const DEFAULT_GET_VIB_DEPOSIT_ADDRESS = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const KEEP_ALIVE_ON_SUCCESS = process.env.VIBLY_E2E_KEEP_ALIVE_ON_SUCCESS === "true";
const KEEP_ALIVE_ON_FAILURE = process.env.VIBLY_E2E_KEEP_ALIVE_ON_FAILURE === "true";

type Json = Record<string, unknown>;
type AnyTx = {
  hash: { toHex(): string };
  method?: { section?: string; method?: string };
  registry?: { findMetaError?: (value: unknown) => { section: string; name: string; docs: string[] } };
  signAndSend: (signer: unknown, cb: (result: { status: { isInBlock: boolean; isFinalized: boolean }; dispatchError?: { toString(): string } }) => void) => Promise<() => void>;
};

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(REPORT_DIR, { recursive: true });
  let relayNode: SoloNodeHandle | undefined;
  let claimNode: SoloNodeHandle | undefined;
  let coordinator: ChildProcessWithoutNullStreams | undefined;
  let completed = false;
  let reportPath: string | undefined;
  let exitWatchers: ExitWatcher[] = [];
  try {
    relayNode = process.env.VIBLY_E2E_EXTERNAL_PAYMENT_CHAIN === "true"
      ? undefined
      : await startSoloNode({ rpcPort: Number(new URL(RELAY_RPC_URL).port || "9945"), rpcExternal: true, serviceName: "payment chain" });
    claimNode = process.env.VIBLY_E2E_EXTERNAL_CHAIN === "true"
      ? undefined
      : await startSoloNode({ rpcPort: Number(new URL(CHAIN_RPC_URL).port || "9955"), rpcExternal: true, serviceName: "Vibly claim chain" });
    coordinator = await startCoordinator();
    exitWatchers = [
      watchUnexpectedExit(relayNode?.child, "payment chain"),
      watchUnexpectedExit(claimNode?.child, "Vibly claim chain"),
      watchUnexpectedExit(coordinator, "Get VIB coordinator"),
    ];

    await Promise.race([
      (async () => {
        const accountId = process.env.VIBLY_E2E_GET_VIB_ACCOUNT ?? await deriveAccountAddress(CLAIM_SURI);
        const config = unwrapKey(await get("/get-vib/config"), "config");
        const depositAddress = String(config.depositAddress ?? config.dotReceivingAddress ?? "");
        if (!depositAddress) throw new Error("Coordinator Get VIB config has no deposit address.");

        const quote = unwrapKey(await get(`/get-vib/quote?amount=${encodeURIComponent(DOT_AMOUNT)}`), "quote");
        const order = unwrapKey(await post("/get-vib/orders", { dotAmount: DOT_AMOUNT, accountId }), "order");
        const relayTxHash = await sendRelayDot({ rpcUrl: RELAY_RPC_URL, suri: RELAY_SURI, to: depositAddress, amount: DOT_AMOUNT });
        const observed = await waitForObservedDeposit(relayTxHash);
        const finalized = await finalizeObservedDeposit({
          observedDepositId: String(observed.id),
          orderId: String(order.id),
          relayTxHash,
        });

        const manifest = unwrapKey(await post("/admin/get-vib/manifests", {}), "manifest");
        const summary = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(accountId)}/summary`), "summary");
        const proof = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(accountId)}/proof`), "proof");
        const chainClaim = await runChainClaimFlow({
          rpcUrl: CHAIN_RPC_URL,
          suri: CLAIM_SURI,
          accountId,
          manifest,
          proof,
          claimableAmount: String(summary.claimableAmount ?? proof.cumulativeAmount ?? "0"),
        });

        const duplicateDeposit = await postRaw("/admin/get-vib/deposits/finalize", {
          observedDepositId: String(observed.id),
          orderId: String(order.id),
        });
        if (duplicateDeposit.ok) throw new Error("Duplicate observed deposit finalize unexpectedly succeeded");

        const delta = await runDeltaClaim({ accountId, depositAddress });
        const records = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(accountId)}/records`), "records");
        const report = {
          status: "passed",
          coordinatorUrl: COORDINATOR_URL,
          relayRpcUrl: RELAY_RPC_URL,
          chainRpcUrl: CHAIN_RPC_URL,
          accountId,
          relayTxHash,
          sourceId: observed.sourceId,
          orderId: order.id,
          quote,
          observed,
          finalized,
          manifestRoot: manifest.merkleRoot,
          summary,
          chainClaim,
          delta,
          duplicateDepositStatus: duplicateDeposit.status,
          records,
        };
        reportPath = path.join(REPORT_DIR, `get-vib-polkadot-local-${Date.now()}.json`);
        await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
        console.log(`[e2e:get-vib:polkadot-local] passed relayTxHash=${relayTxHash} sourceId=${String(observed.sourceId)} report=${reportPath}`);
        completed = true;
      })(),
      ...exitWatchers.map((watcher) => watcher.promise),
    ]);
  } finally {
    for (const watcher of exitWatchers) watcher.dispose();
    const keepAlive = completed ? KEEP_ALIVE_ON_SUCCESS : KEEP_ALIVE_ON_FAILURE;
    if (keepAlive) {
      console.log(`[e2e:get-vib:polkadot-local] Keep-alive mode enabled. Coordinator: ${COORDINATOR_URL}`);
      if (reportPath) console.log(`[e2e:get-vib:polkadot-local] Report: ${reportPath}`);
    } else {
      if (coordinator) await stopCoordinator(coordinator);
      await stopOptionalNode(claimNode);
      await stopOptionalNode(relayNode);
    }
  }
}

async function stopOptionalNode(handle: SoloNodeHandle | undefined): Promise<void> {
  if (handle) await stopSoloNode(handle);
}

async function startCoordinator(): Promise<ChildProcessWithoutNullStreams> {
  if (process.env.VIBLY_E2E_EXTERNAL_COORDINATOR === "true") {
    await waitForHealth(COORDINATOR_URL);
    return fakeChild();
  }
  await assertPortAvailable({
    port: COORDINATOR_PORT,
    serviceName: "Get VIB polkadot-local coordinator",
    portEnv: "VIBLY_E2E_COORDINATOR_PORT",
    externalModeEnv: "VIBLY_E2E_EXTERNAL_COORDINATOR",
  });

  const dbPath = path.join(DATA_DIR, "get-vib-polkadot-local-coordinator.sqlite");
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
      VIBLY_DOT_RECEIVING_ADDRESS:
        process.env.VIBLY_DOT_RECEIVING_ADDRESS ??
        process.env.VIBLY_E2E_GET_VIB_DEPOSIT_ADDRESS ??
        DEFAULT_GET_VIB_DEPOSIT_ADDRESS,
      GET_VIB_RELAY_RPC_URL: RELAY_RPC_URL,
      GET_VIB_RELAY_CHAIN_ID: process.env.GET_VIB_RELAY_CHAIN_ID ?? "polkadot-dev",
      GET_VIB_RELAY_TOKEN_DECIMALS: String(RELAY_TOKEN_DECIMALS),
      GET_VIB_DEPOSIT_SCAN_INTERVAL_MS: process.env.GET_VIB_DEPOSIT_SCAN_INTERVAL_MS ?? "1500",
      GET_VIB_DEPOSIT_FINALITY_BLOCKS: process.env.GET_VIB_DEPOSIT_FINALITY_BLOCKS ?? "1",
    },
    stdio: "pipe",
  });

  pipeChild("coordinator", child);
  await waitForHealth(COORDINATOR_URL);
  return child;
}

async function stopCoordinator(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForHealth(baseUrl: string, timeoutMs = 60_000): Promise<void> {
  await waitForHttp(`${baseUrl}/health`, timeoutMs);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  await waitFor(async () => {
    const response = await fetch(url).catch(() => undefined);
    return response?.ok ? true : undefined;
  }, url, timeoutMs);
}

async function waitFor<T>(fn: () => Promise<T | undefined>, label: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function pipeChild(name: string, child: ChildProcessWithoutNullStreams): void {
  child.stdout.on("data", (chunk: Buffer) => {
    if (process.env.VIBLY_E2E_VERBOSE === "true") process.stdout.write(`[${name}] ${String(chunk)}`);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (process.env.VIBLY_E2E_VERBOSE === "true") process.stderr.write(`[${name}] ${String(chunk)}`);
  });
}

function fakeChild(): ChildProcessWithoutNullStreams {
  return { kill: () => true } as ChildProcessWithoutNullStreams;
}

type ExitWatcher = { promise: Promise<never>; dispose(): void };

function watchUnexpectedExit(
  child: ChildProcessWithoutNullStreams | undefined,
  serviceName: string,
): ExitWatcher {
  if (!child?.pid || typeof child.once !== "function" || typeof child.off !== "function") {
    return { promise: new Promise<never>(() => undefined), dispose: () => undefined };
  }

  let dispose = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      reject(new Error(`${serviceName} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    };
    const onError = (error: Error) => {
      reject(new Error(`${serviceName} errored unexpectedly: ${error.message}`));
    };
    child.once("exit", onExit);
    child.once("error", onError);
    dispose = () => {
      child.off("exit", onExit);
      child.off("error", onError);
    };
  });

  return { promise, dispose };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deriveAccountAddress(suri: string): Promise<string> {
  const [{ Keyring }, { cryptoWaitReady }] = await Promise.all([
    import("@polkadot/keyring"),
    import("@polkadot/util-crypto"),
  ]);
  await cryptoWaitReady();
  return new Keyring({ type: "sr25519" }).addFromUri(suri).address;
}

async function sendRelayDot(input: { rpcUrl: string; suri: string; to: string; amount: string }): Promise<string> {
  const [{ ApiPromise, WsProvider }, { Keyring }, { cryptoWaitReady }] = await Promise.all([
    import("@polkadot/api"),
    import("@polkadot/keyring"),
    import("@polkadot/util-crypto"),
  ]);
  await cryptoWaitReady();
  const api = await ApiPromise.create({ provider: new WsProvider(input.rpcUrl) });
  try {
    const signer = new Keyring({ type: "sr25519" }).addFromUri(input.suri);
    return await signAndWait(api.tx.balances.transferAllowDeath(input.to, decimalToBaseUnits(input.amount, RELAY_TOKEN_DECIMALS)), signer, "finalized");
  } finally {
    await api.disconnect();
  }
}

async function waitForObservedDeposit(txHash: string): Promise<Json> {
  const deadline = Date.now() + Number(process.env.VIBLY_E2E_GET_VIB_OBSERVED_TIMEOUT_MS ?? "60000");
  while (Date.now() < deadline) {
    const deposits = unwrapArrayKey(await get("/admin/get-vib/relay-deposits?limit=100"), "deposits");
    const found = deposits.find((deposit) => String(deposit.extrinsicHash ?? "").toLowerCase() === txHash.toLowerCase());
    if (found) return found;
    await sleep(1500);
  }
  const status = unwrapKey(await get("/admin/get-vib/relay-watcher/status"), "status");
  throw new Error(`Timed out waiting for relay deposit ${txHash}; watcher=${JSON.stringify(status)}`);
}

async function finalizeObservedDeposit(input: {
  observedDepositId: string;
  orderId: string;
  relayTxHash: string;
}): Promise<Json> {
  const response = await postRaw("/admin/get-vib/deposits/finalize", {
    observedDepositId: input.observedDepositId,
    orderId: input.orderId,
  });
  if (response.ok) return unwrapKey(response.body, "result");

  if (response.status === 409 && isAlreadyProcessedConflict(response.body)) {
    const observed = await waitForObservedDeposit(input.relayTxHash);
    return {
      autoProcessed: true,
      observedDepositId: input.observedDepositId,
      confirmedDepositId: observed.confirmedDepositId,
      allocationId: observed.allocationId,
      orderId: observed.orderId,
      accountId: observed.accountId,
      status: observed.status,
    };
  }

  throw new Error(`POST /admin/get-vib/deposits/finalize failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
}

async function runChainClaimFlow(input: {
  rpcUrl: string;
  suri: string;
  accountId: string;
  manifest: Json;
  proof: Json;
  claimableAmount: string;
}) {
  const [{ ApiPromise, WsProvider }, { Keyring }, { cryptoWaitReady }] = await Promise.all([
    import("@polkadot/api"),
    import("@polkadot/keyring"),
    import("@polkadot/util-crypto"),
  ]);
  await cryptoWaitReady();
  const signer = new Keyring({ type: "sr25519" }).addFromUri(input.suri);
  if (signer.address !== input.accountId) {
    throw new Error(`Chain signer address ${signer.address} does not match Get VIB account ${input.accountId}`);
  }
  const api = await ApiPromise.create({ provider: new WsProvider(input.rpcUrl) });
  try {
    const before = ((await api.query.system.account(input.accountId)) as unknown as { data: { free: { toString(): string } } }).data.free.toString();
    const reserve = `0x${"07".repeat(32)}`;
    await signAndWait(
      api.tx.balances.transferAllowDeath(reserve, decimalToBaseUnits(input.claimableAmount, 12)),
      signer,
    );
    await signAndWait(api.tx.sudo.sudo(api.tx.vibClaim.setClaimRoot(
      String(input.manifest.networkId),
      Number(input.manifest.rootVersion),
      String(input.manifest.merkleRoot),
      decimalToBaseUnits(String(input.manifest.totalCumulativeAmount), 12),
      String(input.manifest.metadataHash),
    )), signer);
    const txHash = await signAndWait(api.tx.vibClaim.claim(
      String(input.proof.networkId),
      Number(input.proof.rootVersion),
      String(input.proof.identityId ?? ""),
      decimalToBaseUnits(String(input.proof.cumulativeAmount), 12),
      arrayOfEntities(input.proof.proof).map((item) => ({
        position: String(item.position) === "left" ? "Left" : "Right",
        hash: String(item.hash),
      })),
    ), signer);
    const after = ((await api.query.system.account(input.accountId)) as unknown as { data: { free: { toString(): string } } }).data.free.toString();
    await post("/admin/get-vib/claims", {
      accountId: input.accountId,
      identityId: input.proof.identityId,
      rootVersion: input.proof.rootVersion,
      cumulativeAmount: input.proof.cumulativeAmount,
      claimedDelta: input.claimableAmount,
      txHash,
      status: "confirmed",
    });
    const duplicate = await signAndWaitExpectFailure(api.tx.vibClaim.claim(
      String(input.proof.networkId),
      Number(input.proof.rootVersion),
      String(input.proof.identityId ?? ""),
      decimalToBaseUnits(String(input.proof.cumulativeAmount), 12),
      arrayOfEntities(input.proof.proof).map((item) => ({
        position: String(item.position) === "left" ? "Left" : "Right",
        hash: String(item.hash),
      })),
    ), signer);
    return { status: "passed", txHash, before, after, duplicate };
  } finally {
    await api.disconnect();
  }
}

async function runDeltaClaim(input: { accountId: string; depositAddress: string }) {
  const order = unwrapKey(await post("/get-vib/orders", { dotAmount: DELTA_DOT_AMOUNT, accountId: input.accountId }), "order");
  const relayTxHash = await sendRelayDot({ rpcUrl: RELAY_RPC_URL, suri: RELAY_SURI, to: input.depositAddress, amount: DELTA_DOT_AMOUNT });
  const observed = await waitForObservedDeposit(relayTxHash);
  await finalizeObservedDeposit({
    observedDepositId: String(observed.id),
    orderId: String(order.id),
    relayTxHash,
  });
  const manifest = unwrapKey(await post("/admin/get-vib/manifests", {}), "manifest");
  const summary = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(input.accountId)}/summary`), "summary");
  const proof = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(input.accountId)}/proof`), "proof");
  const [{ ApiPromise, WsProvider }, { Keyring }, { cryptoWaitReady }] = await Promise.all([
    import("@polkadot/api"),
    import("@polkadot/keyring"),
    import("@polkadot/util-crypto"),
  ]);
  await cryptoWaitReady();
  const signer = new Keyring({ type: "sr25519" }).addFromUri(CLAIM_SURI);
  const api = await ApiPromise.create({ provider: new WsProvider(CHAIN_RPC_URL) });
  try {
    const reserve = `0x${"07".repeat(32)}`;
    await signAndWait(
      api.tx.balances.transferAllowDeath(reserve, decimalToBaseUnits(String(summary.claimableAmount), 12)),
      signer,
    );
    await signAndWait(api.tx.sudo.sudo(api.tx.vibClaim.setClaimRoot(
      String(manifest.networkId),
      Number(manifest.rootVersion),
      String(manifest.merkleRoot),
      decimalToBaseUnits(String(manifest.totalCumulativeAmount), 12),
      String(manifest.metadataHash),
    )), signer);
    const before = (await api.query.system.account(input.accountId) as unknown as { data: { free: { toString(): string } } }).data.free.toString();
    const txHash = await signAndWait(api.tx.vibClaim.claim(
      String(proof.networkId),
      Number(proof.rootVersion),
      String(proof.identityId ?? ""),
      decimalToBaseUnits(String(proof.cumulativeAmount), 12),
      arrayOfEntities(proof.proof).map((item) => ({
        position: String(item.position) === "left" ? "Left" : "Right",
        hash: String(item.hash),
      })),
    ), signer);
    const after = (await api.query.system.account(input.accountId) as unknown as { data: { free: { toString(): string } } }).data.free.toString();
    await post("/admin/get-vib/claims", {
      accountId: input.accountId,
      identityId: proof.identityId,
      rootVersion: proof.rootVersion,
      cumulativeAmount: proof.cumulativeAmount,
      claimedDelta: summary.claimableAmount,
      txHash,
      status: "confirmed",
    });
    return { relayTxHash, sourceId: observed.sourceId, txHash, before, after, summary };
  } finally {
    await api.disconnect();
  }
}

async function signAndWait(tx: unknown, signer: unknown, waitFor: "inBlock" | "finalized" = "inBlock"): Promise<string> {
  const submittable = tx as AnyTx;
  return await new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    submittable.signAndSend(signer, (result) => {
      if (result.dispatchError) {
        unsub?.();
        reject(new Error(describeDispatchError(submittable, result.dispatchError)));
        return;
      }
      if (result.status.isFinalized || (waitFor === "inBlock" && result.status.isInBlock)) {
        unsub?.();
        resolve(submittable.hash.toHex());
      }
    }).then((fn) => {
      unsub = fn;
    }).catch(reject);
  });
}

async function signAndWaitExpectFailure(tx: unknown, signer: unknown): Promise<string> {
  try {
    await signAndWait(tx, signer);
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  throw new Error("Expected duplicate claim to fail");
}

async function get(route: string): Promise<Json> {
  const response = await fetch(`${COORDINATOR_URL}${route}`, {
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  });
  return parse(response);
}

async function post(route: string, body: Json): Promise<Json> {
  const response = await postRaw(route, body);
  if (!response.ok) throw new Error(`POST ${route} failed: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

async function postRaw(route: string, body: Json): Promise<{ ok: boolean; status: number; body: Json }> {
  const response = await fetch(`${COORDINATOR_URL}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { ok: response.ok, status: response.status, body: await response.json() as Json };
}

async function parse(response: Response): Promise<Json> {
  const body = await response.json() as Json;
  if (!response.ok) throw new Error(`HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

function unwrapKey(value: Json, key: string): Json {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Missing data.${key}`);
  const nested = (data as Json)[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) throw new Error(`Missing data.${key}`);
  return nested as Json;
}

function unwrapArrayKey(value: Json, key: string): Json[] {
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Missing data.${key}`);
  return arrayOfEntities((data as Json)[key]);
}

function isAlreadyProcessedConflict(value: Json): boolean {
  const error = value.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  return String((error as Json).message ?? "") === "Get VIB deposit already processed";
}

function describeDispatchError(submittable: AnyTx, dispatchError: { toString(): string } & Record<string, unknown>): string {
  const callLabel = [submittable.method?.section, submittable.method?.method].filter(Boolean).join(".") || "extrinsic";
  const maybeModule = dispatchError as { isModule?: boolean; asModule?: unknown };
  if (maybeModule.isModule && maybeModule.asModule && submittable.registry?.findMetaError) {
    const meta = submittable.registry.findMetaError(maybeModule.asModule);
    const docs = Array.isArray(meta.docs) && meta.docs.length > 0 ? `: ${meta.docs.join(" ")}` : "";
    return `${callLabel} failed: ${meta.section}.${meta.name}${docs}`;
  }
  return `${callLabel} failed: ${dispatchError.toString()}`;
}

function arrayOfEntities(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

function decimalToBaseUnits(value: string, decimals: number): string {
  const [wholeRaw, fractionRaw = ""] = value.split(".");
  const whole = wholeRaw || "0";
  const fraction = `${fractionRaw}${"0".repeat(decimals)}`.slice(0, decimals);
  return String(BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || "0"));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
