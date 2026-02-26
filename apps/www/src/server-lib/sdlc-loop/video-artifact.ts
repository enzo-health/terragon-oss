import type { DB } from "@terragon/shared/db";
import {
  classifySdlcVideoCaptureFailure,
  persistSdlcVideoCaptureOutcome,
} from "@terragon/shared/model/sdlc-loop";
import type { SdlcVideoFailureClass } from "@terragon/shared/db/types";
import { z } from "zod/v4";

export const SDLC_VIDEO_CAPTURE_RUNTIME_CONTRACT = {
  runner: "agent-browser",
  browser: "chromium",
  container: "mp4",
  codec: "h264",
  maxDurationMs: 120_000,
  timeoutMs: 180_000,
  maxArtifactBytes: 100 * 1024 * 1024,
} as const;

const runtimeContractSchema = z.object({
  runner: z.literal("agent-browser"),
  browser: z.literal("chromium"),
  container: z.literal("mp4"),
  codec: z.literal("h264"),
  maxDurationMs: z.number().int().positive().max(300_000),
  timeoutMs: z.number().int().positive().max(600_000),
  maxArtifactBytes: z
    .number()
    .int()
    .positive()
    .max(500 * 1024 * 1024),
});

const captureResultSchema = z.object({
  artifactR2Key: z.string().min(1),
  artifactMimeType: z.string().min(1).default("video/mp4"),
  artifactBytes: z.number().int().positive(),
});

export type SdlcVideoCaptureRuntimeContract = z.infer<
  typeof runtimeContractSchema
>;
export type SdlcVideoCaptureResult = z.infer<typeof captureResultSchema>;

export function validateSdlcVideoCaptureRuntimeContract(
  contract: SdlcVideoCaptureRuntimeContract = SDLC_VIDEO_CAPTURE_RUNTIME_CONTRACT,
) {
  return runtimeContractSchema.parse(contract);
}

export type SdlcVideoCaptureRunner = (
  contract: SdlcVideoCaptureRuntimeContract,
) => Promise<SdlcVideoCaptureResult>;

export async function runSdlcVideoCaptureWithAgentBrowser({
  db,
  loopId,
  headSha,
  loopVersion,
  capture,
  runtimeContract = SDLC_VIDEO_CAPTURE_RUNTIME_CONTRACT,
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  capture: SdlcVideoCaptureRunner;
  runtimeContract?: SdlcVideoCaptureRuntimeContract;
}) {
  const validatedContract =
    validateSdlcVideoCaptureRuntimeContract(runtimeContract);

  try {
    const captureResult = captureResultSchema.parse(
      await capture(validatedContract),
    );

    return {
      status: "captured" as const,
      outcome: await persistSdlcVideoCaptureOutcome({
        db,
        loopId,
        headSha,
        loopVersion,
        artifactR2Key: captureResult.artifactR2Key,
        artifactMimeType: captureResult.artifactMimeType,
        artifactBytes: captureResult.artifactBytes,
      }),
    };
  } catch (error) {
    const classified = classifySdlcVideoCaptureFailure(error);
    return {
      status: "failed" as const,
      failureClass: classified.failureClass as SdlcVideoFailureClass,
      outcome: await persistSdlcVideoCaptureOutcome({
        db,
        loopId,
        headSha,
        loopVersion,
        artifactR2Key: null,
        failureClass: classified.failureClass,
        failureCode: classified.failureCode,
        failureMessage: classified.failureMessage,
      }),
    };
  }
}
