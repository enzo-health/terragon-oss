import { db } from "@/lib/db";
import { parseRepoFullName } from "@/lib/github";
import { redis } from "@/lib/redis";
import { r2Private } from "@/server-lib/r2";
import { getClientIpFromRequest } from "@/server-lib/preview-auth";
import { env } from "@terragon/env/apps-www";
import {
  previewValidationAttempt,
  thread,
  threadRun,
  threadRunContext,
  threadUiValidation,
} from "@terragon/shared/db/schema";
import type {
  PreviewValidationDiffSource,
  PreviewValidationAttemptStatus,
  ThreadUiValidationOutcome,
} from "@terragon/shared/types/preview";
import {
  previewValidationTimeoutCode,
  previewValidationTimeoutReason,
} from "@terragon/shared/types/preview";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { gzipSync } from "node:zlib";
import { convertPullRequestToDraft } from "./github-pr";
import { Octokit } from "octokit";

export const previewValidationMaxAttempts = 3;
export const previewValidationHardTimeoutMs = 8 * 60 * 1000;
const PREVIEW_VALIDATION_RETRY_SCHEDULE_MS = [0, 2 * 60_000, 10 * 60_000];
const PREVIEW_VALIDATION_RETRY_JITTER_RATIO = 0.2;
const PREVIEW_VALIDATION_LEASE_TTL_SECONDS = 8 * 60;
const PREVIEW_VALIDATION_LEASE_PREFIX = "terragon:v1:preview:validate:lease";
const PREVIEW_READY_GUARD_PREFIX = "terragon:v1:preview:ready-guard";
const INTERNAL_MAINTENANCE_HMAC_NAMESPACE = "terragon:v1:internal:hmac";
const INTERNAL_MAINTENANCE_HMAC_MAX_SKEW_MS = 5 * 60 * 1000;
const INTERNAL_MAINTENANCE_HMAC_ALLOWLIST_KEY =
  "terragon:v1:internal:hmac:ip_allowlist";
const READY_GUARD_DEDUP_TTL_SECONDS = 24 * 60 * 60;

const LOG_SIZE_CAP_BYTES = 10 * 1024 * 1024;
const SCREENSHOT_SIZE_CAP_BYTES = 5 * 1024 * 1024;
const TRACE_SIZE_CAP_BYTES = 25 * 1024 * 1024;
const VIDEO_SIZE_CAP_BYTES = 50 * 1024 * 1024;

const READY_BLOCKED_OUTCOMES: ReadonlySet<ThreadUiValidationOutcome> = new Set([
  "pending",
  "failed",
  "inconclusive",
  "blocked",
]);

type RedactionRule = {
  pattern: RegExp;
  replacement: string;
};

const REDACTION_RULES: readonly RedactionRule[] = [
  {
    pattern: /sk-[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED_OPENAI_KEY]",
  },
  {
    pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: "[REDACTED_ANTHROPIC_KEY]",
  },
  {
    pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    pattern: /(authorization:\s*bearer\s+)[^\s]+/gi,
    replacement: "$1[REDACTED_BEARER_TOKEN]",
  },
  {
    pattern: /((?:token|secret|password|passwd)\s*[:=]\s*)[^\s]+/gi,
    replacement: "$1[REDACTED_SECRET]",
  },
];

export const uiReadyGuardEntrypoints = [
  {
    id: "openPullRequestForThread",
    filePath: "apps/www/src/agent/pull-request.ts",
    marker: "UI_READY_GUARD:openPullRequestForThread",
  },
  {
    id: "markPRReadyForReview",
    filePath: "apps/www/src/server-actions/mark-pr-ready.ts",
    marker: "UI_READY_GUARD:markPRReadyForReview",
  },
  {
    id: "checkpointAutoReady",
    filePath: "apps/www/src/server-lib/checkpoint-thread-internal.ts",
    marker: "UI_READY_GUARD:checkpointAutoReady",
  },
  {
    id: "reopenAfterPush",
    filePath: "apps/www/src/agent/pull-request.ts",
    marker: "UI_READY_GUARD:reopenAfterPush",
  },
  {
    id: "webhookAutoReady",
    filePath: "apps/www/src/app/api/webhooks/github/handlers.ts",
    marker: "UI_READY_GUARD:webhookAutoReady",
  },
] as const;

export type UiReadyGuardEntrypointId =
  (typeof uiReadyGuardEntrypoints)[number]["id"];

type UiReadyGuardDecision = {
  allowed: boolean;
  reason: string | null;
  threadChatId: string | null;
  runId: string | null;
  uiValidationOutcome: ThreadUiValidationOutcome;
};

type ResolvedGuardContext = {
  threadChatId: string | null;
  runId: string | null;
};

type ValidationArtifactInput = {
  body: Buffer;
  contentType: string;
  contentEncoding?: string;
  maxBytes: number;
  fileName: string;
};

type PersistedValidationArtifact = {
  r2Key: string;
  sha256: string;
  bytes: number;
};

type PersistedValidationArtifacts = {
  summary?: PersistedValidationArtifact;
  stdout?: PersistedValidationArtifact;
  stderr?: PersistedValidationArtifact;
  trace?: PersistedValidationArtifact;
  screenshot?: PersistedValidationArtifact;
  video?: PersistedValidationArtifact;
};

export type PreviewValidationCapabilitySnapshot = {
  playwright: {
    healthcheck: boolean;
    screenshot: boolean;
    video: boolean;
    browsers: string[];
  };
  network: {
    sse: boolean;
    websocket: boolean;
  };
};

export class UiReadyGuardBlockedError extends Error {
  constructor(
    public readonly runId: string | null,
    reason: string,
  ) {
    super(reason);
    this.name = "UiReadyGuardBlockedError";
  }
}

export class PreviewValidationLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewValidationLeaseError";
  }
}

export class PreviewMaintenanceAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PreviewMaintenanceAuthError";
  }
}

export function redactPreviewValidationLog(raw: string): string {
  return REDACTION_RULES.reduce(
    (value, rule) => value.replace(rule.pattern, rule.replacement),
    raw,
  );
}

export function computePreviewValidationRetryScheduleMs(
  random: () => number = Math.random,
): number[] {
  return PREVIEW_VALIDATION_RETRY_SCHEDULE_MS.map((delayMs) => {
    if (delayMs === 0) {
      return 0;
    }
    const jitterDelta = Math.floor(
      delayMs * PREVIEW_VALIDATION_RETRY_JITTER_RATIO,
    );
    const randomValue = Math.min(0.999999, Math.max(0, random()));
    const offset =
      Math.floor(randomValue * (jitterDelta * 2 + 1)) - jitterDelta;
    return Math.max(0, delayMs + offset);
  });
}

function toBuffer(input: string | Uint8Array | Buffer): Buffer {
  if (typeof input === "string") {
    return Buffer.from(input);
  }
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

function sha256Hex(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function getValidationLeaseEnv(): string {
  return (
    process.env.VERCEL_ENV ??
    process.env.NEXT_PUBLIC_VERCEL_ENV ??
    process.env.NODE_ENV ??
    "unknown"
  );
}

function isKnownUiReadyEntrypoint(
  entrypoint: string,
): entrypoint is UiReadyGuardEntrypointId {
  return uiReadyGuardEntrypoints.some(
    (candidate) => candidate.id === entrypoint,
  );
}

export function buildPreviewValidationLeaseKey({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string;
}): string {
  return `${PREVIEW_VALIDATION_LEASE_PREFIX}:${getValidationLeaseEnv()}:${threadId}:${runId}`;
}

function buildReadyGuardIdempotencyKey({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string;
}): string {
  return `${PREVIEW_READY_GUARD_PREFIX}:${threadId}:${runId}:convert_to_draft`;
}

export async function acquirePreviewValidationLease({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string;
}): Promise<string> {
  const ownerToken = randomUUID();
  const key = buildPreviewValidationLeaseKey({ threadId, runId });
  const result = await redis.set(key, ownerToken, {
    nx: true,
    ex: PREVIEW_VALIDATION_LEASE_TTL_SECONDS,
  });
  if (result !== "OK") {
    throw new PreviewValidationLeaseError("Validation lease is already held");
  }
  return ownerToken;
}

export async function releasePreviewValidationLease({
  threadId,
  runId,
  ownerToken,
}: {
  threadId: string;
  runId: string;
  ownerToken: string;
}): Promise<void> {
  const key = buildPreviewValidationLeaseKey({ threadId, runId });
  const currentOwner = await redis.get<string>(key);
  if (currentOwner === ownerToken) {
    await redis.del(key);
  }
}

async function resolveThreadChatAndRun({
  threadId,
  threadChatId,
  runId,
}: {
  threadId: string;
  threadChatId: string | null;
  runId: string | null;
}): Promise<ResolvedGuardContext> {
  if (threadChatId && runId) {
    return { threadChatId, runId };
  }

  if (threadChatId) {
    const context = await db.query.threadRunContext.findFirst({
      where: and(
        eq(threadRunContext.threadId, threadId),
        eq(threadRunContext.threadChatId, threadChatId),
      ),
      columns: {
        activeRunId: true,
      },
    });
    return {
      threadChatId,
      runId: runId ?? context?.activeRunId ?? null,
    };
  }

  const latestContext = await db.query.threadRunContext.findFirst({
    where: eq(threadRunContext.threadId, threadId),
    orderBy: [desc(threadRunContext.activeUpdatedAt)],
    columns: {
      threadChatId: true,
      activeRunId: true,
    },
  });

  return {
    threadChatId: latestContext?.threadChatId ?? null,
    runId: runId ?? latestContext?.activeRunId ?? null,
  };
}

async function ensureThreadUiValidation({
  threadId,
  threadChatId,
  runId,
}: {
  threadId: string;
  threadChatId: string;
  runId: string | null;
}): Promise<void> {
  await db
    .insert(threadUiValidation)
    .values({
      threadId,
      threadChatId,
      latestRunId: runId,
      uiValidationOutcome: "not_required",
      readyDowngradeState: "not_attempted",
    })
    .onConflictDoNothing();

  if (runId) {
    await db
      .update(threadUiValidation)
      .set({
        latestRunId: runId,
      })
      .where(
        and(
          eq(threadUiValidation.threadId, threadId),
          eq(threadUiValidation.threadChatId, threadChatId),
        ),
      );
  }
}

export async function evaluateUiReadyGuard({
  threadId,
  threadChatId,
  runId,
}: {
  threadId: string;
  threadChatId?: string | null;
  runId?: string | null;
}): Promise<UiReadyGuardDecision> {
  const resolvedContext = await resolveThreadChatAndRun({
    threadId,
    threadChatId: threadChatId ?? null,
    runId: runId ?? null,
  });

  if (!resolvedContext.threadChatId) {
    return {
      allowed: true,
      reason: null,
      threadChatId: null,
      runId: resolvedContext.runId,
      uiValidationOutcome: "not_required",
    };
  }

  await ensureThreadUiValidation({
    threadId,
    threadChatId: resolvedContext.threadChatId,
    runId: resolvedContext.runId,
  });

  const validationRow = await db.query.threadUiValidation.findFirst({
    where: and(
      eq(threadUiValidation.threadId, threadId),
      eq(threadUiValidation.threadChatId, resolvedContext.threadChatId),
    ),
    columns: {
      uiValidationOutcome: true,
      blockingReason: true,
    },
  });

  const outcome = validationRow?.uiValidationOutcome ?? "not_required";
  const reason =
    validationRow?.blockingReason ??
    "UI validation has not passed for the latest run.";

  return {
    allowed: !READY_BLOCKED_OUTCOMES.has(outcome),
    reason: READY_BLOCKED_OUTCOMES.has(outcome) ? reason : null,
    threadChatId: resolvedContext.threadChatId,
    runId: resolvedContext.runId,
    uiValidationOutcome: outcome,
  };
}

type WithUiReadyGuardArgs<T> = {
  entrypoint: UiReadyGuardEntrypointId;
  threadId: string;
  threadChatId?: string | null;
  runId?: string | null;
  action: (decision: UiReadyGuardDecision) => Promise<T>;
  onBlocked?: (decision: UiReadyGuardDecision) => Promise<T>;
};

export async function withUiReadyGuard<T>({
  entrypoint,
  threadId,
  threadChatId,
  runId,
  action,
  onBlocked,
}: WithUiReadyGuardArgs<T>): Promise<T> {
  if (!isKnownUiReadyEntrypoint(entrypoint)) {
    throw new Error(`Unknown UI ready entrypoint: ${entrypoint}`);
  }

  const decision = await evaluateUiReadyGuard({
    threadId,
    threadChatId,
    runId,
  });
  if (!decision.allowed) {
    if (onBlocked) {
      return await onBlocked(decision);
    }
    throw new UiReadyGuardBlockedError(
      decision.runId,
      decision.reason ?? "UI validation blocked ready transition",
    );
  }
  return await action(decision);
}

export async function convertToDraftOnceForUiGuard({
  threadId,
  runId,
  threadChatId,
  repoFullName,
  prNumber,
  octokit,
}: {
  threadId: string;
  runId: string;
  threadChatId: string | null;
  repoFullName: string;
  prNumber: number;
  octokit: Octokit;
}): Promise<"converted" | "already_draft" | "skipped"> {
  const idempotencyKey = buildReadyGuardIdempotencyKey({ threadId, runId });
  const lock = await redis.set(idempotencyKey, "1", {
    nx: true,
    ex: READY_GUARD_DEDUP_TTL_SECONDS,
  });
  if (lock !== "OK") {
    return "skipped";
  }

  const [owner, repo] = parseRepoFullName(repoFullName);
  const now = new Date();
  try {
    const result = await convertPullRequestToDraft({
      octokit,
      owner,
      repo,
      prNumber,
    });

    if (threadChatId) {
      await db
        .update(threadUiValidation)
        .set({
          readyDowngradeState: "converted_to_draft",
          readyDowngradeLastAttemptAt: now,
        })
        .where(
          and(
            eq(threadUiValidation.threadId, threadId),
            eq(threadUiValidation.threadChatId, threadChatId),
          ),
        );
    }

    return result;
  } catch (error) {
    if (threadChatId) {
      await db
        .update(threadUiValidation)
        .set({
          readyDowngradeState: "conversion_failed",
          readyDowngradeLastAttemptAt: now,
          blockingReason: "UI validation guard failed to convert PR to draft.",
        })
        .where(
          and(
            eq(threadUiValidation.threadId, threadId),
            eq(threadUiValidation.threadChatId, threadChatId),
          ),
        );
    }
    throw error;
  }
}

function parseBase64Artifact(input: string): Buffer {
  return Buffer.from(input, "base64");
}

async function persistValidationArtifact({
  threadId,
  runId,
  attemptNumber,
  artifact,
}: {
  threadId: string;
  runId: string;
  attemptNumber: number;
  artifact: ValidationArtifactInput;
}): Promise<PersistedValidationArtifact> {
  if (artifact.body.byteLength > artifact.maxBytes) {
    throw new Error(
      `${artifact.fileName} exceeds ${Math.floor(artifact.maxBytes / (1024 * 1024))}MB cap`,
    );
  }

  const artifactSha = sha256Hex(artifact.body);
  const key = [
    "preview-validation",
    threadId,
    runId,
    `attempt-${attemptNumber}`,
    artifact.fileName,
  ].join("/");

  await r2Private.uploadData({
    key,
    data: artifact.body,
    contentType: artifact.contentType,
    contentEncoding: artifact.contentEncoding,
    metadata: {
      sha256: artifactSha,
      bytes: String(artifact.body.byteLength),
    },
  });

  const head = await r2Private.getObjectMetadata(key);
  if (
    head.metadata.sha256 !== artifactSha ||
    Number(head.metadata.bytes ?? "0") !== artifact.body.byteLength
  ) {
    throw new Error(
      `Uploaded metadata verification failed for ${artifact.fileName}`,
    );
  }

  const downloaded = await r2Private.downloadData(key);
  if (
    downloaded.byteLength !== artifact.body.byteLength ||
    sha256Hex(downloaded) !== artifactSha
  ) {
    throw new Error(
      `Durable read verification failed for ${artifact.fileName}`,
    );
  }

  return {
    r2Key: key,
    sha256: artifactSha,
    bytes: artifact.body.byteLength,
  };
}

async function verifyArtifactBeforeDecision(
  artifact: PersistedValidationArtifact | undefined,
): Promise<boolean> {
  if (!artifact) {
    return false;
  }
  const downloaded = await r2Private.downloadData(artifact.r2Key);
  return (
    downloaded.byteLength === artifact.bytes &&
    sha256Hex(downloaded) === artifact.sha256
  );
}

export async function persistValidationArtifacts({
  threadId,
  runId,
  attemptNumber,
  stdout,
  stderr,
  summaryJson,
  traceZipBase64,
  screenshotBase64,
  videoBase64,
}: {
  threadId: string;
  runId: string;
  attemptNumber: number;
  stdout: string;
  stderr: string;
  summaryJson?: string;
  traceZipBase64?: string;
  screenshotBase64?: string;
  videoBase64?: string;
}): Promise<PersistedValidationArtifacts> {
  const redactedStdout = redactPreviewValidationLog(stdout);
  const redactedStderr = redactPreviewValidationLog(stderr);
  const stdoutBytes = Buffer.from(redactedStdout, "utf8");
  const stderrBytes = Buffer.from(redactedStderr, "utf8");

  if (stdoutBytes.byteLength > LOG_SIZE_CAP_BYTES) {
    throw new Error("stdout log exceeds 10MB cap");
  }
  if (stderrBytes.byteLength > LOG_SIZE_CAP_BYTES) {
    throw new Error("stderr log exceeds 10MB cap");
  }

  const persisted: PersistedValidationArtifacts = {};
  persisted.stdout = await persistValidationArtifact({
    threadId,
    runId,
    attemptNumber,
    artifact: {
      body: gzipSync(stdoutBytes),
      contentType: "text/plain",
      contentEncoding: "gzip",
      maxBytes: LOG_SIZE_CAP_BYTES,
      fileName: "stdout.log.gz",
    },
  });
  persisted.stderr = await persistValidationArtifact({
    threadId,
    runId,
    attemptNumber,
    artifact: {
      body: gzipSync(stderrBytes),
      contentType: "text/plain",
      contentEncoding: "gzip",
      maxBytes: LOG_SIZE_CAP_BYTES,
      fileName: "stderr.log.gz",
    },
  });

  if (summaryJson) {
    persisted.summary = await persistValidationArtifact({
      threadId,
      runId,
      attemptNumber,
      artifact: {
        body: toBuffer(summaryJson),
        contentType: "application/json",
        maxBytes: LOG_SIZE_CAP_BYTES,
        fileName: "summary.json",
      },
    });
  }

  if (traceZipBase64) {
    persisted.trace = await persistValidationArtifact({
      threadId,
      runId,
      attemptNumber,
      artifact: {
        body: parseBase64Artifact(traceZipBase64),
        contentType: "application/zip",
        maxBytes: TRACE_SIZE_CAP_BYTES,
        fileName: "trace.zip",
      },
    });
  }

  if (screenshotBase64) {
    persisted.screenshot = await persistValidationArtifact({
      threadId,
      runId,
      attemptNumber,
      artifact: {
        body: parseBase64Artifact(screenshotBase64),
        contentType: "image/png",
        maxBytes: SCREENSHOT_SIZE_CAP_BYTES,
        fileName: "screenshot.png",
      },
    });
  }

  if (videoBase64) {
    persisted.video = await persistValidationArtifact({
      threadId,
      runId,
      attemptNumber,
      artifact: {
        body: parseBase64Artifact(videoBase64),
        contentType: "video/webm",
        maxBytes: VIDEO_SIZE_CAP_BYTES,
        fileName: "video.webm",
      },
    });
  }

  return persisted;
}

export async function assertPassCriteria({
  artifacts,
  capabilities,
  videoUnsupportedReason,
}: {
  artifacts: PersistedValidationArtifacts;
  capabilities: PreviewValidationCapabilitySnapshot;
  videoUnsupportedReason: string | null;
}): Promise<void> {
  const summaryOk = await verifyArtifactBeforeDecision(artifacts.summary);
  const traceOk = await verifyArtifactBeforeDecision(artifacts.trace);
  const screenshotOk = await verifyArtifactBeforeDecision(artifacts.screenshot);
  if (!summaryOk || !traceOk || !screenshotOk) {
    throw new Error(
      "Passed validation requires summary.json, trace.zip, and screenshot artifacts",
    );
  }

  if (!capabilities.playwright.video && !videoUnsupportedReason) {
    throw new Error(
      "videoUnsupportedReason is required when capability probe reports video=false",
    );
  }
  if (capabilities.playwright.video && videoUnsupportedReason) {
    throw new Error(
      "videoUnsupportedReason can only be set when capability probe reports video=false",
    );
  }
}

export async function getNextValidationAttemptNumber({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string;
}): Promise<number> {
  const [row] = await db
    .select({
      maxAttempt: sql<number>`coalesce(max(${previewValidationAttempt.attemptNumber}), 0)`,
    })
    .from(previewValidationAttempt)
    .where(
      and(
        eq(previewValidationAttempt.threadId, threadId),
        eq(previewValidationAttempt.runId, runId),
      ),
    );
  return (row?.maxAttempt ?? 0) + 1;
}

function mapAttemptStatusToValidationOutcome(
  status: PreviewValidationAttemptStatus,
): ThreadUiValidationOutcome {
  switch (status) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "unsupported":
      return "inconclusive";
    case "inconclusive":
      return "inconclusive";
    case "pending":
    case "running":
      return "pending";
    default:
      return "blocked";
  }
}

export async function recordValidationAttempt({
  threadId,
  threadChatId,
  runId,
  attemptNumber,
  status,
  command,
  exitCode,
  durationMs,
  diffSource,
  diffSourceContextJson,
  matchedUiRulesJson,
  capabilitySnapshotJson,
  artifacts,
  videoUnsupportedReason,
  timeoutCode,
  timeoutReason,
}: {
  threadId: string;
  threadChatId: string;
  runId: string;
  attemptNumber: number;
  status: PreviewValidationAttemptStatus;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  diffSource: PreviewValidationDiffSource;
  diffSourceContextJson: Record<string, unknown> | null;
  matchedUiRulesJson: Record<string, unknown> | null;
  capabilitySnapshotJson: Record<string, unknown>;
  artifacts: PersistedValidationArtifacts;
  videoUnsupportedReason: string | null;
  timeoutCode: string | null;
  timeoutReason: string | null;
}): Promise<void> {
  await db.insert(previewValidationAttempt).values({
    threadId,
    threadChatId,
    runId,
    attemptNumber,
    status,
    command,
    exitCode,
    durationMs,
    diffSource,
    diffSourceContextJson: diffSourceContextJson ?? undefined,
    matchedUiRulesJson: matchedUiRulesJson ?? undefined,
    capabilitySnapshotJson,
    summaryR2Key: artifacts.summary?.r2Key,
    summarySha256: artifacts.summary?.sha256,
    summaryBytes: artifacts.summary?.bytes,
    stdoutR2Key: artifacts.stdout?.r2Key,
    stdoutSha256: artifacts.stdout?.sha256,
    stdoutBytes: artifacts.stdout?.bytes,
    stderrR2Key: artifacts.stderr?.r2Key,
    stderrSha256: artifacts.stderr?.sha256,
    stderrBytes: artifacts.stderr?.bytes,
    traceR2Key: artifacts.trace?.r2Key,
    traceSha256: artifacts.trace?.sha256,
    traceBytes: artifacts.trace?.bytes,
    screenshotR2Key: artifacts.screenshot?.r2Key,
    screenshotSha256: artifacts.screenshot?.sha256,
    screenshotBytes: artifacts.screenshot?.bytes,
    videoR2Key: artifacts.video?.r2Key,
    videoSha256: artifacts.video?.sha256,
    videoBytes: artifacts.video?.bytes,
    videoUnsupportedReason,
    timeoutCode,
    timeoutReason,
  });

  await db
    .update(threadUiValidation)
    .set({
      latestRunId: runId,
      uiValidationOutcome: mapAttemptStatusToValidationOutcome(status),
      blockingReason:
        status === "failed" || status === "inconclusive"
          ? "Latest UI validation run did not produce a ready signal."
          : null,
    })
    .where(
      and(
        eq(threadUiValidation.threadId, threadId),
        eq(threadUiValidation.threadChatId, threadChatId),
      ),
    );
}

export function probeValidationCapabilities({
  sandboxProvider,
  forceHealthcheck = false,
}: {
  sandboxProvider: string;
  forceHealthcheck?: boolean;
}): PreviewValidationCapabilitySnapshot {
  if (forceHealthcheck) {
    return {
      playwright: {
        healthcheck: true,
        screenshot: true,
        video: false,
        browsers: ["chromium"],
      },
      network: {
        sse: true,
        websocket: false,
      },
    };
  }

  if (sandboxProvider === "daytona") {
    return {
      playwright: {
        healthcheck: false,
        screenshot: false,
        video: false,
        browsers: [],
      },
      network: {
        sse: true,
        websocket: false,
      },
    };
  }

  return {
    playwright: {
      healthcheck: false,
      screenshot: false,
      video: false,
      browsers: [],
    },
    network: {
      sse: false,
      websocket: false,
    },
  };
}

function fallbackInternalHmacSecret(kid: string): string {
  return createHash("sha256")
    .update(
      `${env.INTERNAL_SHARED_SECRET}:${INTERNAL_MAINTENANCE_HMAC_NAMESPACE}:${kid}`,
    )
    .digest("hex");
}

async function getInternalHmacKid(
  which: "active" | "prev",
): Promise<string | null> {
  const key = `${INTERNAL_MAINTENANCE_HMAC_NAMESPACE}:${which}_kid`;
  const value = await redis.get<string>(key);
  if (!value) {
    return which === "active" ? "internal-v1" : null;
  }
  return value;
}

async function getInternalHmacSecret(kid: string): Promise<string> {
  const key = `${INTERNAL_MAINTENANCE_HMAC_NAMESPACE}:${kid}`;
  const secret = await redis.get<string>(key);
  return secret ?? fallbackInternalHmacSecret(kid);
}

function buildInternalHmacPayload({
  timestamp,
  body,
}: {
  timestamp: string;
  body: string;
}): string {
  return `${timestamp}.${body}`;
}

function parseSignatureValue(signatureHeader: string): string | null {
  if (!signatureHeader) {
    return null;
  }
  if (signatureHeader.startsWith("sha256=")) {
    return signatureHeader.slice("sha256=".length);
  }
  if (signatureHeader.startsWith("v1=")) {
    return signatureHeader.slice("v1=".length);
  }
  return signatureHeader;
}

function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return timingSafeEqual(a, b);
}

async function verifyMaintenanceHmac({
  signatureHeader,
  timestampHeader,
  body,
}: {
  signatureHeader: string | null;
  timestampHeader: string | null;
  body: string;
}): Promise<void> {
  const signature = parseSignatureValue(signatureHeader ?? "");
  if (!signature || !timestampHeader) {
    throw new PreviewMaintenanceAuthError(401, "Missing maintenance signature");
  }

  const timestampMs = Number(timestampHeader);
  if (!Number.isFinite(timestampMs)) {
    throw new PreviewMaintenanceAuthError(
      401,
      "Invalid maintenance signature timestamp",
    );
  }
  const now = Date.now();
  if (Math.abs(now - timestampMs) > INTERNAL_MAINTENANCE_HMAC_MAX_SKEW_MS) {
    throw new PreviewMaintenanceAuthError(401, "Maintenance signature expired");
  }

  const payload = buildInternalHmacPayload({
    timestamp: timestampHeader,
    body,
  });

  const [activeKid, prevKid] = await Promise.all([
    getInternalHmacKid("active"),
    getInternalHmacKid("prev"),
  ]);
  const kids = [activeKid, prevKid].filter((kid): kid is string => !!kid);
  if (kids.length === 0) {
    kids.push("internal-v1");
  }

  for (const kid of [...new Set(kids)]) {
    const secret = await getInternalHmacSecret(kid);
    const digest = createHmac("sha256", secret).update(payload).digest("hex");
    if (constantTimeEqualHex(signature, digest)) {
      return;
    }
  }

  throw new PreviewMaintenanceAuthError(401, "Maintenance signature mismatch");
}

async function getMaintenanceAllowlist(): Promise<string[]> {
  const raw = await redis.get<string>(INTERNAL_MAINTENANCE_HMAC_ALLOWLIST_KEY);
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function verifyMaintenanceIpAllowlist(request: Request): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  const allowlist = await getMaintenanceAllowlist();
  if (allowlist.length === 0) {
    throw new PreviewMaintenanceAuthError(
      403,
      "Maintenance IP allowlist is not configured",
    );
  }

  const { ip } = getClientIpFromRequest(request);
  if (!allowlist.includes("*") && !allowlist.includes(ip)) {
    throw new PreviewMaintenanceAuthError(403, "Maintenance IP is not allowed");
  }
}

export async function authenticatePreviewMaintenanceRequest({
  request,
  body,
}: {
  request: Request;
  body: string;
}): Promise<void> {
  await Promise.all([
    verifyMaintenanceHmac({
      signatureHeader:
        request.headers.get("x-terragon-signature") ??
        request.headers.get("x-signature"),
      timestampHeader:
        request.headers.get("x-terragon-timestamp") ??
        request.headers.get("x-signature-timestamp"),
      body,
    }),
    verifyMaintenanceIpAllowlist(request),
  ]);
}

export async function createPreviewValidationSignedUrls({
  attemptThreadId,
  attemptRunId,
  attemptNumber,
}: {
  attemptThreadId: string;
  attemptRunId: string;
  attemptNumber: number;
}): Promise<Record<string, string>> {
  const attempt = await db.query.previewValidationAttempt.findFirst({
    where: and(
      eq(previewValidationAttempt.threadId, attemptThreadId),
      eq(previewValidationAttempt.runId, attemptRunId),
      eq(previewValidationAttempt.attemptNumber, attemptNumber),
    ),
    columns: {
      summaryR2Key: true,
      stdoutR2Key: true,
      stderrR2Key: true,
      traceR2Key: true,
      screenshotR2Key: true,
      videoR2Key: true,
    },
  });
  if (!attempt) {
    return {};
  }

  const signedUrls = await Promise.all(
    (
      [
        ["summary", attempt.summaryR2Key],
        ["stdout", attempt.stdoutR2Key],
        ["stderr", attempt.stderrR2Key],
        ["trace", attempt.traceR2Key],
        ["screenshot", attempt.screenshotR2Key],
        ["video", attempt.videoR2Key],
      ] as const
    )
      .filter(([, key]) => !!key)
      .map(async ([label, key]) => [
        label,
        await r2Private.generatePresignedDownloadUrl(key!),
      ]),
  );

  return Object.fromEntries(signedUrls);
}

export async function findThreadContextForRun({
  threadId,
  runId,
}: {
  threadId: string;
  runId: string;
}): Promise<{
  threadId: string;
  threadChatId: string;
  runId: string;
  userId: string;
  sandboxProvider: string;
  githubRepoFullName: string;
  githubPRNumber: number | null;
} | null> {
  const row = await db
    .select({
      threadId: threadRun.threadId,
      threadChatId: threadRun.threadChatId,
      runId: threadRun.runId,
      userId: thread.userId,
      sandboxProvider: threadRun.sandboxProvider,
      githubRepoFullName: thread.githubRepoFullName,
      githubPRNumber: thread.githubPRNumber,
    })
    .from(threadRun)
    .innerJoin(thread, eq(thread.id, threadRun.threadId))
    .where(and(eq(threadRun.threadId, threadId), eq(threadRun.runId, runId)))
    .limit(1);
  const result = row[0];
  if (!result || !result.sandboxProvider) {
    return null;
  }
  return {
    ...result,
    sandboxProvider: result.sandboxProvider,
  };
}

export function buildTimeoutSentinel(): {
  timeoutCode: typeof previewValidationTimeoutCode;
  timeoutReason: typeof previewValidationTimeoutReason;
} {
  return {
    timeoutCode: previewValidationTimeoutCode,
    timeoutReason: previewValidationTimeoutReason,
  };
}
