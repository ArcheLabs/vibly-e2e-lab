import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STATE_VERSION = 1;
const DEFAULT_POLL_MS = 30_000;

type Json = Record<string, unknown>;

export interface ProjectRoundDriverConfig {
  coordinatorUrl: string;
  apiToken: string;
  organizationId: string;
  projectId: string;
  bootstrapPrincipalId: string;
  chainId: string;
  pollMs: number;
  once: boolean;
  clientVersion: string;
  contractVersion: string;
  protocolVersion: string;
  clientPackage: string;
}

export interface CoordinationRound {
  id: string;
  roundIndex?: number;
  observationSubmitDeadlineAt?: string;
}

export interface ProcessedProjectRound {
  roundId: string;
  roundIndex?: number;
  observationTaskId: string;
  idempotencyKey: string;
  deadline?: string;
  processedAt: string;
}

export interface ProjectRoundDriverState {
  version: typeof STATE_VERSION;
  organizationId: string;
  projectId: string;
  coordinatorUrl: string;
  chainId: string;
  processedRounds: Record<string, ProcessedProjectRound>;
  createdAt: string;
  updatedAt: string;
}

export function safeProjectId(projectId: string): string {
  return projectId.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function statePathForProject(projectId: string): string {
  return path.join(DATA_DIR, "project-round-drivers", safeProjectId(projectId), "state.json");
}

export function buildIdempotencyKey(projectId: string, roundId: string): string {
  return `lumen:vibmath:project-round:${projectId}:${roundId}:observation`;
}

export function createObservationPayload(config: ProjectRoundDriverConfig, round: CoordinationRound): Json {
  return {
    organizationId: config.organizationId,
    projectId: config.projectId,
    title: `Lumen VibMath project observation round #${round.roundIndex ?? round.id}`,
    description: `Project-scoped observation task mirrored from Coordinator global round ${round.id}.`,
    mechanismId: "mechanism_vibing_math_live",
    deadline: round.observationSubmitDeadlineAt,
  };
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ProjectRoundDriverConfig {
  return {
    coordinatorUrl: requireEnv(env, "LUMEN_COORDINATOR_URL"),
    apiToken: requireEnv(env, "COORDINATOR_API_TOKEN"),
    organizationId: requireEnv(env, "VIBLY_E2E_ORGANIZATION_ID"),
    projectId: requireEnv(env, "VIBLY_E2E_PROJECT_ID"),
    bootstrapPrincipalId: requireEnv(env, "VIBLY_E2E_BOOTSTRAP_PRINCIPAL_ID"),
    chainId: requireEnv(env, "VIBLY_E2E_CHAIN_ID"),
    pollMs: numberEnv(env, "VIBLY_E2E_PROJECT_ROUND_POLL_MS", DEFAULT_POLL_MS),
    once: env.VIBLY_E2E_PROJECT_ROUND_ONCE === "true",
    clientVersion: env.VIBLY_E2E_CLIENT_VERSION ?? "0.1.1",
    contractVersion: env.VIBLY_E2E_CONTRACT_VERSION ?? "0.1.1",
    protocolVersion: env.VIBLY_E2E_PROTOCOL_VERSION ?? "0.2",
    clientPackage: env.VIBLY_E2E_CLIENT_PACKAGE ?? "vibly-e2e-lab",
  };
}

export async function loadState(config: ProjectRoundDriverConfig): Promise<ProjectRoundDriverState> {
  const file = statePathForProject(config.projectId);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as ProjectRoundDriverState;
    return {
      ...parsed,
      organizationId: config.organizationId,
      projectId: config.projectId,
      coordinatorUrl: config.coordinatorUrl,
      chainId: config.chainId,
      processedRounds: parsed.processedRounds ?? {},
    };
  } catch {
    const now = new Date().toISOString();
    return {
      version: STATE_VERSION,
      organizationId: config.organizationId,
      projectId: config.projectId,
      coordinatorUrl: config.coordinatorUrl,
      chainId: config.chainId,
      processedRounds: {},
      createdAt: now,
      updatedAt: now,
    };
  }
}

export async function saveState(config: ProjectRoundDriverConfig, state: ProjectRoundDriverState): Promise<void> {
  const file = statePathForProject(config.projectId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
}

export async function processCurrentRound(config: ProjectRoundDriverConfig): Promise<"created" | "skipped"> {
  const round = await fetchCurrentRound(config);
  console.log(`[lumen:project-round] current round id=${round.id} index=${round.roundIndex ?? "unknown"}`);

  const state = await loadState(config);
  if (state.processedRounds[round.id]) {
    console.log(`[lumen:project-round] skipped existing round id=${round.id}`);
    return "skipped";
  }

  const idempotencyKey = buildIdempotencyKey(config.projectId, round.id);
  const result = await submitActionIntent(config, {
    type: "CreateObservationTask",
    principalId: config.bootstrapPrincipalId,
    idempotencyKey,
    payload: createObservationPayload(config, round),
  });
  const observationTaskId = String(result.aggregateRef.id);

  state.processedRounds[round.id] = {
    roundId: round.id,
    roundIndex: round.roundIndex,
    observationTaskId,
    idempotencyKey,
    deadline: round.observationSubmitDeadlineAt,
    processedAt: new Date().toISOString(),
  };
  await saveState(config, state);
  console.log(`[lumen:project-round] created observation task id=${observationTaskId}`);
  return "created";
}

export async function runDriver(config = readConfig()): Promise<void> {
  console.log(
    `[lumen:project-round] coordinator client version headers: package=${config.clientPackage} client=${config.clientVersion} contract=${config.contractVersion} protocol=${config.protocolVersion}`,
  );

  while (true) {
    await processCurrentRound(config);
    if (config.once) return;
    const nextPollAt = new Date(Date.now() + config.pollMs).toISOString();
    console.log(`[lumen:project-round] next poll time=${nextPollAt}`);
    await sleep(config.pollMs);
  }
}

async function fetchCurrentRound(config: ProjectRoundDriverConfig): Promise<CoordinationRound> {
  const body = await get(config, "/coordination/rounds/current");
  const round = unwrapKey<Json>(body, "round");
  const id = stringField(round, "id");
  if (!id) throw new Error("Coordinator current round response did not include round.id");
  return {
    id,
    roundIndex: numberField(round, "roundIndex"),
    observationSubmitDeadlineAt: stringField(round, "observationSubmitDeadlineAt"),
  };
}

async function submitActionIntent(
  config: ProjectRoundDriverConfig,
  body: Json,
): Promise<{ aggregateRef: { id: string; kind: string } }> {
  const response = await post(config, "/action-intents", body);
  return unwrapData<{ aggregateRef: { id: string; kind: string } }>(response);
}

async function get(config: ProjectRoundDriverConfig, route: string): Promise<Json> {
  const response = await fetch(`${config.coordinatorUrl}${route}`, {
    headers: coordinatorHeaders(config),
  });
  return parseResponse(route, response, "GET");
}

async function post(config: ProjectRoundDriverConfig, route: string, body: Json): Promise<Json> {
  const response = await fetch(`${config.coordinatorUrl}${route}`, {
    method: "POST",
    headers: coordinatorHeaders(config, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  return parseResponse(route, response, "POST");
}

function coordinatorHeaders(config: ProjectRoundDriverConfig, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${config.apiToken}`,
    "x-vibly-client-version": config.clientVersion,
    "x-vibly-contract-version": config.contractVersion,
    "x-vibly-protocol-version": config.protocolVersion,
    "x-vibly-client-package": config.clientPackage,
    "x-vibly-network-id": config.chainId,
    ...extra,
  };
}

async function parseResponse(route: string, response: Response, method: string): Promise<Json> {
  const text = await response.text();
  const body = text ? tryParseJson(text) : {};
  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body
      ? JSON.stringify((body as { error?: unknown }).error)
      : text.slice(0, 500);
    throw new Error(`${method} ${route} failed: HTTP ${response.status} ${response.statusText} ${message}`);
  }
  return body;
}

function unwrapData<T>(body: Json): T {
  const envelope = body as { data?: unknown };
  return (envelope.data ?? body) as T;
}

function unwrapKey<T>(body: Json, key: string): T {
  const data = (body as { data?: unknown }).data;
  if (data && typeof data === "object" && key in data) {
    return (data as Record<string, unknown>)[key] as T;
  }
  if (key in body) return body[key] as T;
  return body as T;
}

function tryParseJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { text };
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" ? field : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryPoint === import.meta.url) {
  runDriver().catch((err) => {
    console.error(`[lumen:project-round] failed: ${String(err)}`);
    process.exit(1);
  });
}
