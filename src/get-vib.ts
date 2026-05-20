import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPORT_DIR = path.join(ROOT, "reports");
const COORDINATOR_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:8787";
const API_TOKEN = process.env.COORDINATOR_API_TOKEN ?? "dev-token";

type Json = Record<string, unknown>;

async function main() {
  await mkdir(REPORT_DIR, { recursive: true });
  const accountId = process.env.VIBLY_E2E_GET_VIB_ACCOUNT ?? "0x1111111111111111111111111111111111111111111111111111111111111111";
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
    duplicateStatus: duplicate.status,
  };
  const reportPath = path.join(REPORT_DIR, `get-vib-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`[e2e:get-vib] passed report=${reportPath}`);
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
