import { describe, expect, it } from "vitest";
import {
  buildIdempotencyKey,
  createObservationPayload,
  readConfig,
  safeProjectId,
  statePathForProject,
  type CoordinationRound,
  type ProjectRoundDriverConfig,
} from "./lumenProjectRoundDriver.js";

const config: ProjectRoundDriverConfig = {
  coordinatorUrl: "https://coordinator.example",
  apiToken: "token",
  organizationId: "org_1",
  projectId: "projectid_abc",
  bootstrapPrincipalId: "principal_bootstrap",
  chainId: "substrate:vibly-testnet",
  pollMs: 30_000,
  once: false,
  clientVersion: "0.1.1",
  contractVersion: "0.1.1",
  protocolVersion: "0.2",
  clientPackage: "vibly-e2e-lab",
};

describe("lumenProjectRoundDriver", () => {
  it("builds the required project round idempotency key", () => {
    expect(buildIdempotencyKey("project_1", "round_2")).toBe(
      "lumen:vibmath:project-round:project_1:round_2:observation",
    );
  });

  it("sanitizes project ids for local state paths", () => {
    expect(safeProjectId(" project/id:1 ")).toBe("project-id-1");
    expect(statePathForProject("project/id:1")).toContain("data/project-round-drivers/project-id-1/state.json");
  });

  it("creates an observation payload tied to the existing org/project and round deadline", () => {
    const round: CoordinationRound = {
      id: "round_1",
      roundIndex: 42,
      observationSubmitDeadlineAt: "2026-06-11T08:00:00.000Z",
    };

    expect(createObservationPayload(config, round)).toMatchObject({
      organizationId: "org_1",
      projectId: "projectid_abc",
      mechanismId: "mechanism_vibing_math_live",
      deadline: "2026-06-11T08:00:00.000Z",
      title: "Lumen VibMath project observation round #42",
    });
  });

  it("reads required env and defaults polling/version values", () => {
    expect(readConfig({
      LUMEN_COORDINATOR_URL: "https://coordinator.example",
      COORDINATOR_API_TOKEN: "token",
      VIBLY_E2E_ORGANIZATION_ID: "org_1",
      VIBLY_E2E_PROJECT_ID: "project_1",
      VIBLY_E2E_BOOTSTRAP_PRINCIPAL_ID: "principal_bootstrap",
      VIBLY_E2E_CHAIN_ID: "substrate:vibly-testnet",
    })).toMatchObject({
      pollMs: 30_000,
      once: false,
      clientVersion: "0.1.1",
      contractVersion: "0.1.1",
      protocolVersion: "0.2",
      clientPackage: "vibly-e2e-lab",
    });
  });
});
