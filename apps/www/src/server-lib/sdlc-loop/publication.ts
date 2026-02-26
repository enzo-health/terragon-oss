import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { r2Private } from "@/server-lib/r2";
import {
  claimNextSdlcOutboxActionForExecution,
  clearSdlcCanonicalStatusCommentReference,
  completeSdlcOutboxActionExecution,
  persistSdlcCanonicalCheckRunReference,
  persistSdlcCanonicalStatusCommentReference,
  type ClaimedSdlcOutboxAction,
  type SdlcOutboxErrorClass,
} from "@terragon/shared/model/sdlc-loop";
import type { DB } from "@terragon/shared/db";
import { eq } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { z } from "zod/v4";

const STATUS_COMMENT_PAYLOAD_SCHEMA = z.object({
  repoFullName: z.string().min(1),
  prNumber: z.number().int().positive(),
  body: z.string().min(1),
});

const CHECK_SUMMARY_PAYLOAD_SCHEMA = z.object({
  repoFullName: z.string().min(1),
  prNumber: z.number().int().positive(),
  title: z.string().min(1).default("Terragon SDLC Loop"),
  summary: z.string().min(1),
  status: z.enum(["queued", "in_progress", "completed"]).default("completed"),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "timed_out",
      "action_required",
      "stale",
      "skipped",
    ])
    .optional(),
  detailsUrl: z.string().url().optional(),
  artifactR2Key: z.string().min(1).optional(),
});

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return null;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function parseGitHubNumericId(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed;
}

async function buildReviewerSafeVideoArtifactLink(
  artifactR2Key: string | undefined,
): Promise<string | null> {
  if (!artifactR2Key) {
    return null;
  }

  const signedUrl = await r2Private.generatePresignedDownloadUrl(
    artifactR2Key,
    15 * 60,
  );
  return `🎥 [Session video artifact (expires in 15 minutes)](${signedUrl})`;
}

export async function upsertSdlcCanonicalStatusComment({
  db,
  loopId,
  repoFullName,
  prNumber,
  body,
}: {
  db: DB;
  loopId: string;
  repoFullName: string;
  prNumber: number;
  body: string;
}) {
  const loop = await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
  });

  if (!loop) {
    throw new Error(`SDLC loop not found: ${loopId}`);
  }

  const [owner, repo] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });

  const existingCommentId = parseGitHubNumericId(loop.canonicalStatusCommentId);
  if (existingCommentId) {
    try {
      const updatedComment = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingCommentId,
        body,
      });

      await persistSdlcCanonicalStatusCommentReference({
        db,
        loopId,
        commentId: String(updatedComment.data.id),
        commentNodeId: updatedComment.data.node_id,
      });

      return {
        commentId: String(updatedComment.data.id),
        wasCreated: false,
        wasRecreatedAfterMissing: false,
      };
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        throw error;
      }

      await clearSdlcCanonicalStatusCommentReference({ db, loopId });
    }
  }

  const createdComment = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });

  await persistSdlcCanonicalStatusCommentReference({
    db,
    loopId,
    commentId: String(createdComment.data.id),
    commentNodeId: createdComment.data.node_id,
  });

  return {
    commentId: String(createdComment.data.id),
    wasCreated: true,
    wasRecreatedAfterMissing: Boolean(existingCommentId),
  };
}

export async function upsertSdlcCanonicalCheckSummary({
  db,
  loopId,
  payload,
}: {
  db: DB;
  loopId: string;
  payload: z.infer<typeof CHECK_SUMMARY_PAYLOAD_SCHEMA>;
}) {
  const loop = await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
  });

  if (!loop) {
    throw new Error(`SDLC loop not found: ${loopId}`);
  }

  const [owner, repo] = parseRepoFullName(payload.repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });

  const artifactLink = await buildReviewerSafeVideoArtifactLink(
    payload.artifactR2Key,
  );
  const summaryWithArtifactLink = artifactLink
    ? `${payload.summary}\n\n---\n${artifactLink}`
    : payload.summary;

  if (loop.canonicalCheckRunId) {
    try {
      await octokit.rest.checks.update({
        owner,
        repo,
        check_run_id: loop.canonicalCheckRunId,
        status: payload.status,
        conclusion: payload.conclusion,
        details_url: payload.detailsUrl,
        output: {
          title: payload.title,
          summary: summaryWithArtifactLink,
        },
      });

      await persistSdlcCanonicalCheckRunReference({
        db,
        loopId,
        checkRunId: loop.canonicalCheckRunId,
      });

      return {
        checkRunId: loop.canonicalCheckRunId,
        wasCreated: false,
      };
    } catch (error) {
      if (getErrorStatus(error) !== 404) {
        throw error;
      }
    }
  }

  const pr = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: payload.prNumber,
  });

  const checkRun = await octokit.rest.checks.create({
    owner,
    repo,
    head_sha: pr.data.head.sha,
    name: payload.title,
    status: payload.status,
    conclusion: payload.conclusion,
    details_url: payload.detailsUrl,
    output: {
      title: payload.title,
      summary: summaryWithArtifactLink,
    },
  });

  await persistSdlcCanonicalCheckRunReference({
    db,
    loopId,
    checkRunId: checkRun.data.id,
  });

  return {
    checkRunId: checkRun.data.id,
    wasCreated: true,
  };
}

export function classifySdlcPublicationFailure(error: unknown): {
  errorClass: SdlcOutboxErrorClass;
  errorCode: string;
  retriable: boolean;
  message: string;
} {
  const status = getErrorStatus(error);
  const message =
    error instanceof Error
      ? error.message
      : `Unknown publication error: ${String(error)}`;

  if (status === 401 || status === 403) {
    return {
      errorClass: "auth",
      errorCode: "github_auth",
      retriable: false,
      message,
    };
  }

  if (status === 429) {
    return {
      errorClass: "quota",
      errorCode: "github_rate_limit",
      retriable: true,
      message,
    };
  }

  if (status && status >= 500) {
    return {
      errorClass: "infra",
      errorCode: "github_upstream_5xx",
      retriable: true,
      message,
    };
  }

  if (status && status >= 400) {
    return {
      errorClass: "script",
      errorCode: "github_request_invalid",
      retriable: false,
      message,
    };
  }

  return {
    errorClass: "unknown",
    errorCode: "publication_unknown",
    retriable: true,
    message,
  };
}

async function executeClaimedPublicationAction({
  db,
  claimedAction,
}: {
  db: DB;
  claimedAction: ClaimedSdlcOutboxAction;
}) {
  if (claimedAction.actionType === "publish_status_comment") {
    const payload = STATUS_COMMENT_PAYLOAD_SCHEMA.parse(claimedAction.payload);
    await upsertSdlcCanonicalStatusComment({
      db,
      loopId: claimedAction.loopId,
      repoFullName: payload.repoFullName,
      prNumber: payload.prNumber,
      body: payload.body,
    });
    return;
  }

  if (claimedAction.actionType === "publish_check_summary") {
    const payload = CHECK_SUMMARY_PAYLOAD_SCHEMA.parse(claimedAction.payload);
    await upsertSdlcCanonicalCheckSummary({
      db,
      loopId: claimedAction.loopId,
      payload,
    });
    return;
  }

  throw new Error(
    `Unsupported SDLC publication action: ${claimedAction.actionType}`,
  );
}

export async function executeNextSdlcOutboxPublicationAction({
  db,
  loopId,
  leaseOwner,
  leaseEpoch,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  leaseOwner: string;
  leaseEpoch: number;
  now?: Date;
}) {
  const claimedAction = await claimNextSdlcOutboxActionForExecution({
    db,
    loopId,
    leaseOwner,
    leaseEpoch,
    allowedActionTypes: ["publish_status_comment", "publish_check_summary"],
    now,
  });

  if (!claimedAction) {
    return {
      executed: false as const,
      reason: "no_eligible_action" as const,
    };
  }

  try {
    await executeClaimedPublicationAction({ db, claimedAction });
    const completion = await completeSdlcOutboxActionExecution({
      db,
      outboxId: claimedAction.id,
      leaseOwner,
      succeeded: true,
      now,
    });

    return {
      executed: true as const,
      outboxId: claimedAction.id,
      completion,
    };
  } catch (error) {
    const classified = classifySdlcPublicationFailure(error);
    const completion = await completeSdlcOutboxActionExecution({
      db,
      outboxId: claimedAction.id,
      leaseOwner,
      succeeded: false,
      retriable: classified.retriable,
      errorClass: classified.errorClass,
      errorCode: classified.errorCode,
      errorMessage: classified.message,
      now,
    });

    return {
      executed: true as const,
      outboxId: claimedAction.id,
      completion,
      publicationError: classified,
    };
  }
}
