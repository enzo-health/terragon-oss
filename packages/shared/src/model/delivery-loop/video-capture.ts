import { and, eq, isNull, lte, or } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type { SdlcLoopState, SdlcVideoFailureClass } from "../../db/types";
import type { DeliveryLoopState } from "./types";
import {
  coerceDeliveryLoopResumableState,
  DELIVERY_LOOP_CANONICAL_STATE_SET,
} from "./types";
import {
  reducePersistedDeliveryLoopState,
  mapSdlcTransitionEventToDeliveryLoopTransition,
} from "./state-machine";
import type { SdlcLoopTransitionEvent } from "./state-constants";
import { resolveSdlcLoopNextState } from "./legacy-transitions";
import { normalizeOutboxErrorMessage } from "./outbox";

export function classifySdlcVideoCaptureFailure(error: unknown): {
  failureClass: SdlcVideoFailureClass;
  failureCode: string;
  failureMessage: string;
} {
  const failureMessage =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : (JSON.stringify(error) ?? String(error));
  const normalized = failureMessage.toLowerCase();

  if (
    /(401|403|unauthori[sz]ed|forbidden|auth|token|permission denied)/.test(
      normalized,
    )
  ) {
    return {
      failureClass: "auth",
      failureCode: "video_capture_auth",
      failureMessage,
    };
  }

  if (/(429|quota|rate limit|insufficient credits|billing)/.test(normalized)) {
    return {
      failureClass: "quota",
      failureCode: "video_capture_quota",
      failureMessage,
    };
  }

  if (
    /(script|selector|assert|dom|playwright|puppeteer|navigation failed)/.test(
      normalized,
    )
  ) {
    return {
      failureClass: "script",
      failureCode: "video_capture_script",
      failureMessage,
    };
  }

  return {
    failureClass: "infra",
    failureCode: "video_capture_infra",
    failureMessage,
  };
}

export function resolveSdlcReadyStateAfterVideoCapture({
  currentState,
  artifactR2Key,
}: {
  currentState: SdlcLoopState;
  artifactR2Key: string | null;
}): Extract<SdlcLoopState, "babysitting" | "implementing" | "done"> | null {
  const transitionEvent: SdlcLoopTransitionEvent = artifactR2Key
    ? "video_capture_succeeded"
    : "video_capture_failed";
  const nextState = resolveSdlcLoopNextState({
    currentState,
    event: transitionEvent,
  });

  if (nextState === "babysitting" || nextState === "implementing") {
    return nextState;
  }

  if (nextState === "done") {
    return "done";
  }

  return null;
}

export async function persistSdlcVideoCaptureOutcome({
  db,
  loopId,
  headSha,
  loopVersion,
  artifactR2Key,
  artifactMimeType,
  artifactBytes,
  failureClass,
  failureCode,
  failureMessage,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  artifactR2Key: string | null;
  artifactMimeType?: string | null;
  artifactBytes?: number | null;
  failureClass?: SdlcVideoFailureClass | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  now?: Date;
}) {
  if (!artifactR2Key && !failureClass) {
    throw new Error(
      "persistSdlcVideoCaptureOutcome requires either an artifact or a failure class",
    );
  }

  const loop = await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
  });

  if (!loop) {
    throw new Error(`SDLC loop not found: ${loopId}`);
  }

  const normalizedLoopVersion = Math.max(Math.trunc(loopVersion), 0);
  if (loop.loopVersion > normalizedLoopVersion) {
    return loop;
  }
  if (
    loop.loopVersion === normalizedLoopVersion &&
    loop.currentHeadSha !== null &&
    loop.currentHeadSha !== headSha
  ) {
    return loop;
  }

  const transitionEvent: SdlcLoopTransitionEvent = artifactR2Key
    ? "video_capture_succeeded"
    : "video_capture_failed";
  const canonicalTransitionEvent =
    mapSdlcTransitionEventToDeliveryLoopTransition(transitionEvent, {
      hasPrLink:
        typeof loop.prNumber === "number" && Number.isFinite(loop.prNumber),
    });
  const reducedTransition =
    DELIVERY_LOOP_CANONICAL_STATE_SET.has(loop.state as DeliveryLoopState) &&
    canonicalTransitionEvent
      ? reducePersistedDeliveryLoopState({
          state: loop.state as DeliveryLoopState,
          blockedFromState: coerceDeliveryLoopResumableState(
            loop.blockedFromState,
          ),
          event: canonicalTransitionEvent,
        })
      : null;
  const nextState =
    reducedTransition?.state ??
    resolveSdlcReadyStateAfterVideoCapture({
      currentState: loop.state,
      artifactR2Key,
    });
  if (!nextState) {
    return loop;
  }

  const whereCondition = and(
    eq(schema.sdlcLoop.id, loopId),
    eq(schema.sdlcLoop.state, loop.state),
    lte(schema.sdlcLoop.loopVersion, normalizedLoopVersion),
    or(
      lte(schema.sdlcLoop.loopVersion, normalizedLoopVersion - 1),
      isNull(schema.sdlcLoop.currentHeadSha),
      eq(schema.sdlcLoop.currentHeadSha, headSha),
    ),
  );

  const [updated] = await db
    .update(schema.sdlcLoop)
    .set({
      currentHeadSha: headSha,
      loopVersion: normalizedLoopVersion,
      state: nextState,
      blockedFromState:
        reducedTransition?.snapshot.kind === "blocked"
          ? reducedTransition.snapshot.from
          : null,
      videoCaptureStatus: artifactR2Key ? "captured" : "failed",
      latestVideoArtifactR2Key: artifactR2Key,
      latestVideoArtifactMimeType: artifactR2Key
        ? (artifactMimeType ?? null)
        : null,
      latestVideoArtifactBytes: artifactR2Key ? (artifactBytes ?? null) : null,
      latestVideoCapturedAt: artifactR2Key ? now : null,
      latestVideoFailureClass: artifactR2Key ? null : (failureClass ?? null),
      latestVideoFailureCode: artifactR2Key ? null : (failureCode ?? null),
      latestVideoFailureMessage: artifactR2Key
        ? null
        : normalizeOutboxErrorMessage(failureMessage ?? null),
      latestVideoFailedAt: artifactR2Key ? null : now,
      updatedAt: now,
    })
    .where(whereCondition)
    .returning();

  if (updated) {
    return updated;
  }

  return await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
  });
}
