import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFrozenRunFlagSnapshot,
  getRunContextRetryDelayMs,
} from "./run-context";

describe("buildFrozenRunFlagSnapshot", () => {
  it("normalizes preview flags to boolean snapshot values", () => {
    const snapshot = buildFrozenRunFlagSnapshot({
      sandboxPreview: true,
      daemonRunIdStrict: false,
    });

    expect(snapshot).toEqual({
      sandboxPreview: true,
      daemonRunIdStrict: false,
      rolloutPhase: null,
    });
  });

  it("falls back to false when flags are missing", () => {
    const snapshot = buildFrozenRunFlagSnapshot({});

    expect(snapshot).toEqual({
      sandboxPreview: false,
      daemonRunIdStrict: false,
      rolloutPhase: null,
    });
  });
});

describe("getRunContextRetryDelayMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies +20 percent jitter at the top of the range", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);

    expect(getRunContextRetryDelayMs(0)).toBe(31);
    expect(getRunContextRetryDelayMs(2)).toBe(121);
  });

  it("applies -20 percent jitter at the bottom of the range", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    expect(getRunContextRetryDelayMs(0)).toBe(20);
    expect(getRunContextRetryDelayMs(2)).toBe(80);
  });
});
