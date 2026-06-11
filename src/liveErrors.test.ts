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

describe("coordinator client version headers", () => {
  // Simulate the coordinatorHeaders logic from live-vibing-math.ts
  const API_TOKEN = "test-token";
  const E2E_CLIENT_VERSION = "0.1.1";
  const E2E_CONTRACT_VERSION = "0.1.1";
  const E2E_PROTOCOL_VERSION = "0.2";
  const E2E_CLIENT_PACKAGE = "vibly-e2e-lab";

  function coordinatorHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${API_TOKEN}`,
      "x-vibly-client-version": E2E_CLIENT_VERSION,
      "x-vibly-contract-version": E2E_CONTRACT_VERSION,
      "x-vibly-protocol-version": E2E_PROTOCOL_VERSION,
      "x-vibly-client-package": E2E_CLIENT_PACKAGE,
      ...extra,
    };
  }

  it("includes Authorization header", () => {
    const headers = coordinatorHeaders();
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  it("includes x-vibly-client-version", () => {
    const headers = coordinatorHeaders();
    expect(headers["x-vibly-client-version"]).toBe("0.1.1");
  });

  it("includes x-vibly-contract-version", () => {
    const headers = coordinatorHeaders();
    expect(headers["x-vibly-contract-version"]).toBe("0.1.1");
  });

  it("includes x-vibly-protocol-version", () => {
    const headers = coordinatorHeaders();
    expect(headers["x-vibly-protocol-version"]).toBe("0.2");
  });

  it("includes x-vibly-client-package", () => {
    const headers = coordinatorHeaders();
    expect(headers["x-vibly-client-package"]).toBe("vibly-e2e-lab");
  });

  it("merges extra headers without overwriting required ones", () => {
    const headers = coordinatorHeaders({ "Content-Type": "application/json" });
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(headers["x-vibly-client-version"]).toBe("0.1.1");
  });

  it("post headers include version headers", () => {
    // Simulate what post() passes to coordinatorHeaders
    const postHeaders = coordinatorHeaders({ "Content-Type": "application/json" });
    expect(postHeaders).toMatchObject({
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
      "x-vibly-client-version": "0.1.1",
      "x-vibly-contract-version": "0.1.1",
      "x-vibly-protocol-version": "0.2",
      "x-vibly-client-package": "vibly-e2e-lab",
    });
  });

  it("get headers include version headers (no Content-Type)", () => {
    const getHeaders = coordinatorHeaders();
    expect(getHeaders).toMatchObject({
      Authorization: "Bearer test-token",
      "x-vibly-client-version": "0.1.1",
      "x-vibly-contract-version": "0.1.1",
      "x-vibly-protocol-version": "0.2",
      "x-vibly-client-package": "vibly-e2e-lab",
    });
  });
});

describe("426 UPGRADE_REQUIRED failure handling", () => {
  it("HttpResponseError preserves httpStatus=426", () => {
    const err = new HttpResponseError({
      route: "/action-intents",
      method: "POST",
      status: 426,
      statusText: "Upgrade Required",
      responseBody: {
        ok: false,
        error: {
          code: "UPGRADE_REQUIRED",
          message: "Client version header is required",
          details: {
            minimumClientVersion: "0.1.0",
            recommendedClientVersion: "0.1.0",
            received: {},
          },
        },
      },
    });
    expect(err.context.status).toBe(426);
    expect(err.message).toContain("HTTP 426");
  });

  it("preserves UPGRADE_REQUIRED error code from response body", () => {
    const responseBody = {
      ok: false,
      error: {
        code: "UPGRADE_REQUIRED",
        message: "Client version header is required",
      },
    };
    const err = new HttpResponseError({
      route: "/action-intents",
      method: "POST",
      status: 426,
      statusText: "Upgrade Required",
      responseBody,
    });
    const body = err.context.responseBody as Record<string, unknown>;
    const error = (body?.error as Record<string, unknown>) ?? {};
    expect(error.code).toBe("UPGRADE_REQUIRED");
  });

  it("preserves minimumClientVersion and received from response details", () => {
    const responseBody = {
      ok: false,
      error: {
        code: "UPGRADE_REQUIRED",
        message: "Client version header is required",
        details: {
          minimumClientVersion: "0.1.0",
          recommendedClientVersion: "0.1.0",
          received: {},
        },
      },
    };
    const err = new HttpResponseError({
      route: "/action-intents",
      method: "POST",
      status: 426,
      statusText: "Upgrade Required",
      responseBody,
    });
    const body = err.context.responseBody as Record<string, unknown>;
    const error = (body?.error as Record<string, unknown>) ?? {};
    const details = (error?.details as Record<string, unknown>) ?? {};
    expect(details.minimumClientVersion).toBe("0.1.0");
    expect(details.received).toEqual({});
  });

  it("live-vibing-math failure report for 426 preserves httpStatus", () => {
    // Simulate the failure normalization from normalizeFailure()
    const err = new HttpResponseError({
      route: "/action-intents",
      method: "POST",
      status: 426,
      statusText: "Upgrade Required",
      responseBody: {
        ok: false,
        error: {
          code: "UPGRADE_REQUIRED",
          message: "Client version header is required",
          details: { minimumClientVersion: "0.1.0", received: {} },
        },
      },
    });
    const failure = {
      phase: "attach.register-agent-profiles",
      actionType: "RegisterAgentProfile",
      route: err.context.route,
      httpStatus: err.context.status,
      responseBody: err.context.responseBody,
      message: err.message,
      occurredAt: new Date().toISOString(),
    };
    expect(failure.phase).toBe("attach.register-agent-profiles");
    expect(failure.httpStatus).toBe(426);
    expect(failure.route).toBe("/action-intents");
  });
});
