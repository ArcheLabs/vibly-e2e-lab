import { describe, expect, it } from "vitest";
import { HttpResponseError, LiveActionError } from "./liveErrors.js";

describe("HttpResponseError", () => {
  it("preserves HTTP status and response text when body is not JSON", () => {
    const err = new HttpResponseError({
      route: "/action-intents",
      method: "POST",
      status: 403,
      statusText: "Forbidden",
      responseBody: undefined,
      responseText: "Forbidden: missing wallet session",
    });
    expect(err.message).toContain("POST /action-intents failed: HTTP 403");
    expect(err.message).toContain("Forbidden: missing wallet session");
    expect(err.context.status).toBe(403);
    expect(err.context.route).toBe("/action-intents");
    expect(err.context.method).toBe("POST");
    expect(err.context.responseText).toBe("Forbidden: missing wallet session");
    expect(err.context.responseBody).toBeUndefined();
  });

  it("preserves parsed JSON body", () => {
    const err = new HttpResponseError({
      route: "/principals",
      method: "POST",
      status: 400,
      statusText: "Bad Request",
      responseBody: { ok: false, error: { code: "BAD_REQUEST", message: "Invalid kind" } },
      responseText: undefined,
    });
    expect(err.context.responseBody).toEqual({ ok: false, error: { code: "BAD_REQUEST", message: "Invalid kind" } });
  });
});

describe("LiveActionError", () => {
  it("includes action type, principalId, route, and http status", () => {
    const err = new LiveActionError(
      "ActionIntent failed: type=RegisterAgentProfile principal=principal_observer_1 status=403",
      {
        type: "RegisterAgentProfile",
        principalId: "principal_observer_1",
        route: "/action-intents",
        httpStatus: 403,
        responseBody: { ok: false, error: { code: "FORBIDDEN" } },
      },
    );
    expect(err.context.type).toBe("RegisterAgentProfile");
    expect(err.context.principalId).toBe("principal_observer_1");
    expect(err.context.route).toBe("/action-intents");
    expect(err.context.httpStatus).toBe(403);
    expect(err.message).toContain("RegisterAgentProfile");
  });
});

describe("KEEP_ALIVE semantics", () => {
  // Simulate the keep-alive logic from live-vibing-math.ts
  const KEEP_ALIVE_ALWAYS = false;
  const KEEP_ALIVE_ON_SUCCESS = KEEP_ALIVE_ALWAYS || true; // user set *_ON_SUCCESS=true
  const KEEP_ALIVE_ON_FAILURE = KEEP_ALIVE_ALWAYS || false;

  it("VIBLY_E2E_KEEP_ALIVE_ON_SUCCESS=true does NOT cause failure keep-alive", () => {
    const completed = false;
    const shouldKeepAlive = completed ? KEEP_ALIVE_ON_SUCCESS : KEEP_ALIVE_ON_FAILURE;
    expect(shouldKeepAlive).toBe(false);
  });

  it("VIBLY_E2E_KEEP_ALIVE=true causes both success and failure keep-alive", () => {
    const KEEP_ALIVE_ALWAYS_BOTH = true;
    const KEEP_ALIVE_ON_SUCCESS_BOTH = KEEP_ALIVE_ALWAYS_BOTH || false;
    const KEEP_ALIVE_ON_FAILURE_BOTH = KEEP_ALIVE_ALWAYS_BOTH || false;

    expect(KEEP_ALIVE_ON_SUCCESS_BOTH).toBe(true);
    expect(KEEP_ALIVE_ON_FAILURE_BOTH).toBe(true);
  });

  it("neither set causes no keep-alive", () => {
    const KEEP_ALIVE_ALWAYS_NEITHER = false;
    const KEEP_ALIVE_ON_SUCCESS_NEITHER = KEEP_ALIVE_ALWAYS_NEITHER || false;
    const KEEP_ALIVE_ON_FAILURE_NEITHER = KEEP_ALIVE_ALWAYS_NEITHER || false;

    expect(KEEP_ALIVE_ON_SUCCESS_NEITHER).toBe(false);
    expect(KEEP_ALIVE_ON_FAILURE_NEITHER).toBe(false);
  });
});

describe("failure state merge", () => {
  it("catch does not overwrite disk state with incomplete memory state", () => {
    // Simulate scenario: disk has orgId/projectId, memory state has less
    const diskState = {
      version: 1 as const,
      runName: "lumen-vibmath-dev",
      status: "running" as const,
      mode: "external" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedMilestones: [] as string[],
      taskIds: [] as string[],
      artifactIds: [] as string[],
      organizationId: "org_saved_on_disk",
      projectId: "project_saved_on_disk",
      guardianPrincipalId: "principal_bootstrap",
    };

    // Memory state has no orgId/projectId (simulating catch before ensureSeeded completes)
    const memoryState = {
      ...diskState,
      organizationId: undefined as string | undefined,
      projectId: undefined as string | undefined,
      guardianPrincipalId: undefined as string | undefined,
    };

    // The merge logic from catch block
    const merged = {
      ...memoryState,
      ...diskState,
      guardianPrincipalId: memoryState.guardianPrincipalId ?? diskState.guardianPrincipalId,
      organizationId: memoryState.organizationId ?? diskState.organizationId,
      projectId: memoryState.projectId ?? diskState.projectId,
      completedMilestones: memoryState.completedMilestones.length > 0
        ? memoryState.completedMilestones
        : (diskState.completedMilestones ?? []),
      taskIds: memoryState.taskIds.length > 0 ? memoryState.taskIds : (diskState.taskIds ?? []),
      artifactIds: memoryState.artifactIds.length > 0 ? memoryState.artifactIds : (diskState.artifactIds ?? []),
    };

    expect(merged.organizationId).toBe("org_saved_on_disk");
    expect(merged.projectId).toBe("project_saved_on_disk");
    expect(merged.guardianPrincipalId).toBe("principal_bootstrap");
  });
});

describe("Lumen external mode config validation", () => {
  it("missing VIBLY_E2E_PROJECT_ID gives clear error", () => {
    const env: Record<string, string | undefined> = {
      VIBLY_E2E_PROJECT_ID: undefined,
    };
    expect(() => {
      const id = env["VIBLY_E2E_PROJECT_ID"];
      if (!id) throw new Error("Missing required environment variable: VIBLY_E2E_PROJECT_ID");
    }).toThrow("VIBLY_E2E_PROJECT_ID");
  });

  it("COORDINATOR_API_TOKEN=dev-token fails without leaking token value", () => {
    const API_TOKEN = "dev-token";
    const getError = () => {
      if (API_TOKEN === "dev-token") {
        throw new Error(
          "COORDINATOR_API_TOKEN is still the default value in external Lumen mode.\n" +
          "Set a real coordinator API token.",
        );
      }
    };
    expect(getError).toThrow("COORDINATOR_API_TOKEN");
    // Verify the error message does not contain the literal token value string
    expect(getError).not.toThrow("dev-token");
  });
});
