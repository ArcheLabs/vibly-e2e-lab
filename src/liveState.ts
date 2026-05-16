import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const PAUSE_BOUNDARIES = [
  "after-seed",
  "after-first-observation",
  "after-proposal",
  "after-artifacts",
  "after-knowledge-sync",
  "before-second-observation",
] as const;

export type PauseBoundary = typeof PAUSE_BOUNDARIES[number];

export type LiveRunStatus = "created" | "running" | "paused" | "passed" | "failed";

export interface LiveRunState {
  version: 1;
  runName: string;
  status: LiveRunStatus;
  mode: "local" | "external";
  createdAt: string;
  updatedAt: string;
  completedMilestones: PauseBoundary[];
  guardianPrincipalId?: string;
  organizationId?: string;
  projectId?: string;
  firstObservationTaskId?: string;
  secondObservationTaskId?: string;
  proposalId?: string;
  taskIds: string[];
  artifactIds: string[];
  pausedAt?: PauseBoundary;
  pausedReason?: string;
}

export function createInitialLiveRunState(input: {
  runName: string;
  mode: "local" | "external";
  now?: string;
}): LiveRunState {
  const now = input.now ?? new Date().toISOString();
  return {
    version: 1,
    runName: input.runName,
    status: "created",
    mode: input.mode,
    createdAt: now,
    updatedAt: now,
    completedMilestones: [],
    taskIds: [],
    artifactIds: [],
  };
}

export function isPauseBoundary(value: string | undefined): value is PauseBoundary {
  return Boolean(value && (PAUSE_BOUNDARIES as readonly string[]).includes(value));
}

export function shouldPauseAt(state: LiveRunState, boundary: PauseBoundary, requested?: string): boolean {
  return requested === boundary && !state.completedMilestones.includes(boundary);
}

export function markMilestone(state: LiveRunState, milestone: PauseBoundary, now = new Date().toISOString()): LiveRunState {
  return {
    ...state,
    status: state.status === "paused" ? "running" : state.status,
    completedMilestones: state.completedMilestones.includes(milestone)
      ? state.completedMilestones
      : [...state.completedMilestones, milestone],
    updatedAt: now,
  };
}

export function liveRunDir(root: string, runName: string): string {
  return path.join(root, "live-runs", sanitizeRunName(runName));
}

export function liveRunStatePath(root: string, runName: string): string {
  return path.join(liveRunDir(root, runName), "state.json");
}

export async function loadLiveRunState(root: string, runName: string): Promise<LiveRunState | undefined> {
  try {
    return JSON.parse(await readFile(liveRunStatePath(root, runName), "utf8")) as LiveRunState;
  } catch {
    return undefined;
  }
}

export async function saveLiveRunState(root: string, state: LiveRunState): Promise<void> {
  const file = liveRunStatePath(root, state.runName);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

export function sanitizeRunName(value: string): string {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "default";
}
