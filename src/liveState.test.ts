import { describe, expect, it } from "vitest";
import {
  createInitialLiveRunState,
  isPauseBoundary,
  markMilestone,
  sanitizeRunName,
  shouldPauseAt,
} from "./liveState.js";

describe("live run state", () => {
  it("sanitizes run names for durable paths", () => {
    expect(sanitizeRunName(" live run / 1 ")).toBe("live-run-1");
    expect(sanitizeRunName("")).toBe("default");
  });

  it("recognizes supported pause boundaries", () => {
    expect(isPauseBoundary("after-proposal")).toBe(true);
    expect(isPauseBoundary("after-nope")).toBe(false);
  });

  it("does not pause twice at a completed milestone", () => {
    const state = markMilestone(
      createInitialLiveRunState({ runName: "x", mode: "local", now: "2026-01-01T00:00:00.000Z" }),
      "after-proposal",
      "2026-01-01T00:00:01.000Z",
    );
    expect(shouldPauseAt(state, "after-proposal", "after-proposal")).toBe(false);
    expect(shouldPauseAt(state, "after-artifacts", "after-artifacts")).toBe(true);
  });
});
