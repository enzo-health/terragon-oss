import { validInternalRequestOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { NextResponse } from "next/server";
import { z } from "zod/v4";
import {
  acquirePreviewValidationLease,
  assertPassCriteria,
  buildTimeoutSentinel,
  computePreviewValidationRetryScheduleMs,
  createPreviewValidationSignedUrls,
  evaluateUiReadyGuard,
  findThreadContextForRun,
  getNextValidationAttemptNumber,
  persistValidationArtifacts,
  previewValidationHardTimeoutMs,
  previewValidationMaxAttempts,
  probeValidationCapabilities,
  recordValidationAttempt,
  releasePreviewValidationLease,
  type PreviewValidationCapabilitySnapshot,
} from "@/server-lib/preview-validation";
import type {
  PreviewValidationAttemptStatus,
  PreviewValidationDiffSource,
} from "@terragon/shared/types/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const validateBodySchema = z.object({
  command: z.string().max(10_000).nullable().optional(),
  status: z
    .enum([
      "pending",
      "running",
      "passed",
      "failed",
      "inconclusive",
      "unsupported",
    ])
    .optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  diffSource: z.enum(["sha", "working-tree-fallback"]).optional(),
  diffSourceContextJson: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional(),
  matchedUiRulesJson: z.record(z.string(), z.unknown()).nullable().optional(),
  summaryJson: z.string().optional(),
  traceZipBase64: z.string().optional(),
  screenshotBase64: z.string().optional(),
  videoBase64: z.string().optional(),
  videoUnsupportedReason: z.string().nullable().optional(),
  forceHealthcheck: z.boolean().optional(),
  simulateTimeout: z.boolean().optional(),
});

function resolveStatus({
  requestedStatus,
  exitCode,
  capabilities,
}: {
  requestedStatus: PreviewValidationAttemptStatus | undefined;
  exitCode: number | null;
  capabilities: PreviewValidationCapabilitySnapshot;
}): PreviewValidationAttemptStatus {
  if (!capabilities.playwright.healthcheck) {
    return "unsupported";
  }
  if (requestedStatus) {
    return requestedStatus;
  }
  if (exitCode === null) {
    return "inconclusive";
  }
  return exitCode === 0 ? "passed" : "failed";
}

export async function POST(
  request: Request,
  context: {
    params: Promise<{ threadId: string; runId: string }>;
  },
) {
  try {
    await validInternalRequestOrThrow();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { threadId, runId } = await context.params;
  const parsedBody = validateBodySchema.safeParse(await request.json());
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsedBody.error.issues },
      { status: 400 },
    );
  }
  const body = parsedBody.data;

  const runContext = await findThreadContextForRun({ threadId, runId });
  if (!runContext) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const isPreviewEnabled = await getFeatureFlagForUser({
    db,
    userId: runContext.userId,
    flagName: "sandboxPreview",
  });
  if (!isPreviewEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let leaseToken: string | null = null;
  try {
    leaseToken = await acquirePreviewValidationLease({ threadId, runId });
  } catch {
    return NextResponse.json(
      { error: "Validation attempt already in progress" },
      { status: 409 },
    );
  }

  try {
    await evaluateUiReadyGuard({
      threadId,
      threadChatId: runContext.threadChatId,
      runId,
    });

    const attemptNumber = await getNextValidationAttemptNumber({
      threadId,
      runId,
    });
    if (attemptNumber > previewValidationMaxAttempts) {
      return NextResponse.json(
        {
          error: "Maximum preview validation attempts reached",
          attemptLimit: previewValidationMaxAttempts,
        },
        { status: 409 },
      );
    }

    const capabilities = probeValidationCapabilities({
      sandboxProvider: runContext.sandboxProvider,
      forceHealthcheck: !!body.forceHealthcheck,
    });
    const status = resolveStatus({
      requestedStatus: body.status,
      exitCode: body.exitCode ?? null,
      capabilities,
    });
    const fallbackDiffSourceContext =
      runContext.runEndSha === null
        ? {
            reason: "missing_end_sha",
            runStartSha: runContext.runStartSha,
            runEndSha: runContext.runEndSha,
          }
        : null;
    const diffSource: PreviewValidationDiffSource =
      body.diffSource ??
      (fallbackDiffSourceContext ? "working-tree-fallback" : "sha");

    const artifacts = await persistValidationArtifacts({
      threadId,
      runId,
      attemptNumber,
      stdout: body.stdout ?? "",
      stderr: body.stderr ?? "",
      summaryJson: body.summaryJson,
      traceZipBase64: body.traceZipBase64,
      screenshotBase64: body.screenshotBase64,
      videoBase64: body.videoBase64,
    });

    let timeoutCode: string | null = null;
    let timeoutReason: string | null = null;
    if (body.simulateTimeout) {
      const timeoutSentinel = buildTimeoutSentinel();
      timeoutCode = timeoutSentinel.timeoutCode;
      timeoutReason = timeoutSentinel.timeoutReason;
    }

    const videoUnsupportedReason =
      status === "unsupported"
        ? (body.videoUnsupportedReason ?? "capability_missing")
        : (body.videoUnsupportedReason ?? null);

    if (status === "passed") {
      await assertPassCriteria({
        artifacts,
        capabilities,
        videoUnsupportedReason,
      });
    }

    await recordValidationAttempt({
      threadId,
      threadChatId: runContext.threadChatId,
      runId,
      attemptNumber,
      status,
      command: body.command ?? null,
      exitCode: body.exitCode ?? null,
      durationMs: body.durationMs ?? null,
      diffSource,
      diffSourceContextJson:
        body.diffSourceContextJson ?? fallbackDiffSourceContext,
      matchedUiRulesJson: body.matchedUiRulesJson ?? null,
      capabilitySnapshotJson: capabilities as Record<string, unknown>,
      artifacts,
      videoUnsupportedReason,
      timeoutCode,
      timeoutReason,
    });

    const retryScheduleMs = computePreviewValidationRetryScheduleMs();
    const nextRetryDelayMs =
      attemptNumber < previewValidationMaxAttempts &&
      (status === "failed" || status === "inconclusive")
        ? (retryScheduleMs[attemptNumber] ?? null)
        : null;
    const nextRetryAt =
      typeof nextRetryDelayMs === "number"
        ? new Date(Date.now() + nextRetryDelayMs).toISOString()
        : null;

    const artifactUrls = await createPreviewValidationSignedUrls({
      attemptThreadId: threadId,
      attemptRunId: runId,
      attemptNumber,
    });

    return NextResponse.json({
      threadId,
      runId,
      attemptNumber,
      status,
      hardTimeoutMs: previewValidationHardTimeoutMs,
      timeoutCode,
      timeoutReason,
      nextRetryAt,
      artifactUrls,
      capabilities,
    });
  } catch (error) {
    console.error("Failed to execute preview validation attempt", {
      threadId,
      runId,
      error,
    });
    return NextResponse.json(
      { error: "Preview validation attempt failed" },
      { status: 500 },
    );
  } finally {
    if (leaseToken) {
      await releasePreviewValidationLease({
        threadId,
        runId,
        ownerToken: leaseToken,
      });
    }
  }
}
