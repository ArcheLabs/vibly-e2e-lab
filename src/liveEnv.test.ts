import { describe, expect, it } from "vitest";
import { resolveLiveEnvironment } from "./liveEnv.js";

describe("resolveLiveEnvironment", () => {
  it("keeps local live runs on the local coordinator even when Lumen env is present", () => {
    expect(resolveLiveEnvironment({
      LUMEN_COORDINATOR_URL: "https://coordinator.example",
      VIBLY_E2E_CHAIN_ID: "substrate:vibly-testnet",
      VIBLY_E2E_EXTERNAL_COORDINATOR: "false",
    })).toMatchObject({
      externalCoordinator: false,
      coordinatorUrl: "http://127.0.0.1:8787",
      chainId: "substrate:vibly-solo",
    });
  });

  it("uses Lumen defaults for explicit Lumen runs", () => {
    expect(resolveLiveEnvironment({
      VIBLY_E2E_PROFILE: "lumen",
      VIBLY_E2E_EXTERNAL_COORDINATOR: "true",
      LUMEN_COORDINATOR_URL: "https://coordinator.example",
      VIBLY_E2E_CHAIN_ID: "substrate:vibly-testnet",
    })).toMatchObject({
      profile: "lumen",
      isLumenProfile: true,
      externalCoordinator: true,
      coordinatorUrl: "https://coordinator.example",
      chainId: "substrate:vibly-testnet",
    });
  });

  it("allows local runs to override the local chain id explicitly", () => {
    expect(resolveLiveEnvironment({
      VIBLY_E2E_LOCAL_CHAIN_ID: "substrate:custom-local",
    }).chainId).toBe("substrate:custom-local");
  });
});
