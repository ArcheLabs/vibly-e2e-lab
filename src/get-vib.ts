import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPORT_DIR = path.join(ROOT, "reports");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";
const CHAIN_RPC_URL = process.env.VIBLY_E2E_GET_VIB_CHAIN_RPC ?? process.env.SUBSTRATE_RPC_URL;
const CLAIM_SURI = process.env.VIBLY_E2E_GET_VIB_CLAIM_SURI ?? "//Alice";

type Json = Record<string, unknown>;
type AnyTx = {
  hash: { toHex(): string };
  signAndSend: (signer: unknown, cb: (result: { status: { isInBlock: boolean; isFinalized: boolean }; dispatchError?: { toString(): string } }) => void) => Promise<() => void>;
};

async function main() {
  await mkdir(REPORT_DIR, { recursive: true });
  const chainAccount = CHAIN_RPC_URL && !process.env.VIBLY_E2E_GET_VIB_ACCOUNT
    ? await deriveAccountAddress(CLAIM_SURI)
    : undefined;
  const accountId = process.env.VIBLY_E2E_GET_VIB_ACCOUNT ?? chainAccount ?? "0x1111111111111111111111111111111111111111111111111111111111111111";
  const dotAmount = process.env.VIBLY_E2E_GET_VIB_DOT ?? "1";
  const sourceId = process.env.VIBLY_E2E_GET_VIB_SOURCE_ID ?? `get-vib-e2e-${Date.now()}`;

  const config = unwrapKey(await get("/get-vib/config"), "config");
  const quote = unwrapKey(await get(`/get-vib/quote?amount=${encodeURIComponent(dotAmount)}`), "quote");
  const order = unwrapKey(await post("/get-vib/orders", { dotAmount, accountId }), "order");
  const finalized = unwrapKey(await post("/admin/get-vib/deposits/finalize", {
    sourceId,
    dotAmount,
    orderId: String(order.id),
    paymentId: sourceId,
  }), "result");
  const manifest = unwrapKey(await post("/admin/get-vib/manifests", {}), "manifest");
  const summary = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(accountId)}/summary`), "summary");
  const proof = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(accountId)}/proof`), "proof");
  const records = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(accountId)}/records`), "records");
  const chainClaim = CHAIN_RPC_URL
    ? await runChainClaimFlow({
      rpcUrl: CHAIN_RPC_URL,
      suri: CLAIM_SURI,
      accountId,
      manifest,
      proof,
      claimableAmount: String(summary.claimableAmount ?? proof.cumulativeAmount ?? "0"),
    })
    : { status: "skipped", reason: "Set VIBLY_E2E_GET_VIB_CHAIN_RPC to run chain claim smoke." };

  const duplicate = await postRaw("/admin/get-vib/deposits/finalize", {
    sourceId,
    dotAmount,
    orderId: String(order.id),
    paymentId: sourceId,
  });
  if (duplicate.ok) throw new Error("Duplicate finalized deposit unexpectedly succeeded");

  const report = {
    status: "passed",
    coordinatorUrl: COORDINATOR_URL,
    accountId,
    config,
    quote,
    order,
    finalized,
    manifest,
    summary,
    proof,
    records,
    chainClaim,
    duplicateStatus: duplicate.status,
  };
  const reportPath = path.join(REPORT_DIR, `get-vib-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`[e2e:get-vib] passed report=${reportPath}`);
}

async function deriveAccountAddress(suri: string): Promise<string> {
  const [{ Keyring }, { cryptoWaitReady }] = await Promise.all([
    import("@polkadot/keyring"),
    import("@polkadot/util-crypto"),
  ]);
  await cryptoWaitReady();
  return new Keyring({ type: "sr25519" }).addFromUri(suri).address;
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
    await signAndWait(api.tx.balances.transferAllowDeath(reserve, "1000000000000000000"), signer);
    await signAndWait(api.tx.vibClaim.setClaimRoot(
      utf8Bytes(String(input.manifest.networkId)),
      Number(input.manifest.rootVersion),
      String(input.manifest.merkleRoot),
      decimalToBaseUnits(String(input.manifest.totalCumulativeAmount)),
      String(input.manifest.metadataHash),
    ), signer);
    const claimHash = await signAndWait(api.tx.vibClaim.claim(
      utf8Bytes(String(input.proof.networkId)),
      Number(input.proof.rootVersion),
      utf8Bytes(String(input.proof.identityId ?? "")),
      decimalToBaseUnits(String(input.proof.cumulativeAmount)),
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
      txHash: claimHash,
      status: "confirmed",
    });
    const duplicate = await signAndWaitExpectFailure(api.tx.vibClaim.claim(
      utf8Bytes(String(input.proof.networkId)),
      Number(input.proof.rootVersion),
      utf8Bytes(String(input.proof.identityId ?? "")),
      decimalToBaseUnits(String(input.proof.cumulativeAmount)),
      arrayOfEntities(input.proof.proof).map((item) => ({
        position: String(item.position) === "left" ? "Left" : "Right",
        hash: String(item.hash),
      })),
    ), signer);
    const delta = await runDeltaClaim({ api, signer, accountId: input.accountId });
    return { status: "passed", txHash: claimHash, before, after, duplicate, delta };
  } finally {
    await api.disconnect();
  }
}

async function runDeltaClaim(input: { api: unknown; signer: unknown; accountId: string }) {
  const api = input.api as {
    tx: {
      vibClaim: {
        setClaimRoot: (...args: unknown[]) => AnyTx;
        claim: (...args: unknown[]) => AnyTx;
      };
    };
    query: { system: { account: (account: string) => Promise<{ data: { free: { toString(): string } } }> } };
  };
  const dotAmount = process.env.VIBLY_E2E_GET_VIB_DELTA_DOT ?? "0.5";
  const sourceId = `get-vib-e2e-delta-${Date.now()}`;
  await post("/admin/get-vib/deposits/finalize", {
    sourceId,
    dotAmount,
    accountId: input.accountId,
    paymentId: sourceId,
  });
  const manifest = unwrapKey(await post("/admin/get-vib/manifests", {}), "manifest");
  const summary = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(input.accountId)}/summary`), "summary");
  const proof = unwrapKey(await get(`/get-vib/account/${encodeURIComponent(input.accountId)}/proof`), "proof");
  await signAndWait(api.tx.vibClaim.setClaimRoot(
    utf8Bytes(String(manifest.networkId)),
    Number(manifest.rootVersion),
    String(manifest.merkleRoot),
    decimalToBaseUnits(String(manifest.totalCumulativeAmount)),
    String(manifest.metadataHash),
  ), input.signer);
  const before = (await api.query.system.account(input.accountId)).data.free.toString();
  const txHash = await signAndWait(api.tx.vibClaim.claim(
    utf8Bytes(String(proof.networkId)),
    Number(proof.rootVersion),
    utf8Bytes(String(proof.identityId ?? "")),
    decimalToBaseUnits(String(proof.cumulativeAmount)),
    arrayOfEntities(proof.proof).map((item) => ({
      position: String(item.position) === "left" ? "Left" : "Right",
      hash: String(item.hash),
    })),
  ), input.signer);
  const after = (await api.query.system.account(input.accountId)).data.free.toString();
  await post("/admin/get-vib/claims", {
    accountId: input.accountId,
    identityId: proof.identityId,
    rootVersion: proof.rootVersion,
    cumulativeAmount: proof.cumulativeAmount,
    claimedDelta: summary.claimableAmount,
    txHash,
    status: "confirmed",
  });
  return { txHash, before, after, summary };
}

async function signAndWait(tx: unknown, signer: unknown): Promise<string> {
  const submittable = tx as AnyTx;
  return await new Promise((resolve, reject) => {
    let unsub: (() => void) | undefined;
    submittable.signAndSend(signer, (result) => {
      if (result.dispatchError) {
        unsub?.();
        reject(new Error(result.dispatchError.toString()));
        return;
      }
      if (result.status.isInBlock || result.status.isFinalized) {
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

function arrayOfEntities(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decimalToBaseUnits(value: string): string {
  const [wholeRaw, fractionRaw = ""] = value.split(".");
  const whole = wholeRaw || "0";
  const fraction = `${fractionRaw}${"0".repeat(12)}`.slice(0, 12);
  return String(BigInt(whole) * 1_000_000_000_000n + BigInt(fraction));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
