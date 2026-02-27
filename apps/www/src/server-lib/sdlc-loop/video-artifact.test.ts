import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  runSdlcVideoCaptureWithAgentBrowser,
  SDLC_VIDEO_CAPTURE_RUNTIME_CONTRACT,
  validateSdlcVideoCaptureRuntimeContract,
} from "./video-artifact";
import {
  classifySdlcVideoCaptureFailure,
  persistSdlcVideoCaptureOutcome,
  transitionSdlcLoopState,
} from "@terragon/shared/model/sdlc-loop";

vi.mock("@terragon/shared/model/sdlc-loop", () => ({
  classifySdlcVideoCaptureFailure: vi.fn(),
  persistSdlcVideoCaptureOutcome: vi.fn(),
  transitionSdlcLoopState: vi.fn(),
}));

describe("sdlc video artifact runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(transitionSdlcLoopState).mockResolvedValue("updated");
  });

  it("validates runtime contract constraints", () => {
    expect(
      validateSdlcVideoCaptureRuntimeContract(
        SDLC_VIDEO_CAPTURE_RUNTIME_CONTRACT,
      ),
    ).toMatchObject({
      runner: "agent-browser",
      browser: "chromium",
      container: "mp4",
      codec: "h264",
    });

    expect(() =>
      validateSdlcVideoCaptureRuntimeContract({
        ...SDLC_VIDEO_CAPTURE_RUNTIME_CONTRACT,
        maxDurationMs: 301_000,
      }),
    ).toThrow();
  });

  it("persists successful capture outcomes", async () => {
    vi.mocked(persistSdlcVideoCaptureOutcome).mockResolvedValue({
      id: "loop-1",
      state: "human_review_ready",
    } as any);

    const result = await runSdlcVideoCaptureWithAgentBrowser({
      db: {} as any,
      loopId: "loop-1",
      headSha: "sha-1",
      loopVersion: 1,
      capture: async () => ({
        artifactR2Key: "videos/loop-1.mp4",
        artifactMimeType: "video/mp4",
        artifactBytes: 1000,
      }),
    });

    expect(result.status).toBe("captured");
    expect(transitionSdlcLoopState).toHaveBeenCalledWith({
      db: {},
      loopId: "loop-1",
      transitionEvent: "video_capture_started",
      headSha: "sha-1",
      loopVersion: 1,
    });
    expect(persistSdlcVideoCaptureOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop-1",
        artifactR2Key: "videos/loop-1.mp4",
      }),
    );
  });

  it("classifies and persists failed capture outcomes", async () => {
    vi.mocked(classifySdlcVideoCaptureFailure).mockReturnValue({
      failureClass: "infra",
      failureCode: "video_capture_infra",
      failureMessage: "runner timeout",
    });
    vi.mocked(persistSdlcVideoCaptureOutcome).mockResolvedValue({
      id: "loop-2",
      state: "video_degraded_ready",
    } as any);

    const result = await runSdlcVideoCaptureWithAgentBrowser({
      db: {} as any,
      loopId: "loop-2",
      headSha: "sha-2",
      loopVersion: 2,
      capture: async () => {
        throw new Error("timeout");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.failureClass).toBe("infra");
    expect(transitionSdlcLoopState).toHaveBeenCalledWith({
      db: {},
      loopId: "loop-2",
      transitionEvent: "video_capture_started",
      headSha: "sha-2",
      loopVersion: 2,
    });
    expect(persistSdlcVideoCaptureOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop-2",
        artifactR2Key: null,
        failureClass: "infra",
      }),
    );
  });
});
