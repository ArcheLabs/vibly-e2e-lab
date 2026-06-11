import process from "node:process";
import { hasSoloNodeBinary } from "./soloNode.js";

export function resolveUseRealStake(entrypoint: string): boolean {
  // External infrastructure (Lumen testnet) always requires real stake;
  // the MOCK_STAKE flag should not override this — the .env may have
  // VIBLY_E2E_MOCK_STAKE=true for local runs while Lumen scripts set
  // VIBLY_E2E_EXTERNAL_COORDINATOR=true.
  const usesExternalStakeInfra =
    process.env.VIBLY_E2E_EXTERNAL_COORDINATOR === "true" ||
    process.env.VIBLY_E2E_EXTERNAL_CHAIN === "true" ||
    process.env.VIBLY_E2E_EXTERNAL_INDEXER === "true";
  if (usesExternalStakeInfra) return true;

  if (process.env.VIBLY_E2E_MOCK_STAKE === "true") return false;
  if (process.env.VIBLY_E2E_USE_REAL_STAKE === "true") return true;

  if (process.env.VIBLY_E2E_BUILD_CHAIN === "true") return true;
  if (hasSoloNodeBinary()) return true;

  throw new Error(
    [
      `[e2e] ${entrypoint}: vibly-solo-node binary not found.`,
      "All E2E commands require the local chain components to boot or be explicitly provided.",
      "Build it with: cd ../vibly-chain && cargo build -p vibly-solo-node",
      "Or let the runner build it automatically: VIBLY_E2E_BUILD_CHAIN=true",
    ].join(" "),
  );
}
