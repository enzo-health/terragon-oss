import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { publicAppUrl } from "@terragon/env/next-public";
import {
  clearSdlcCanonicalStatusCommentReference,
  persistSdlcCanonicalCheckRunReference,
  persistSdlcCanonicalStatusCommentReference,
  type SdlcOutboxErrorClass,
} from "@terragon/shared/model/delivery-loop";
import type { DB } from "@terragon/shared/db";
import { eq } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { z } from "zod/v4";

const CHECK_SUMMARY_PAYLOAD_SCHEMA = z.object({
  repoFullName: z.string().min(1),
  prNumber: z.number().int().positive(),
  title: z.string().min(1).default("Terragon Delivery Loop"),
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

const SDLC_STATUS_COMMENT_MARKER_PREFIX = "terragon-sdlc-loop-status-comment:";
const SDLC_CHECK_RUN_EXTERNAL_ID_PREFIX = "terragon-sdlc-loop-check-run:";

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
  threadId: string,
): Promise<string | null> {
  if (!artifactR2Key) {
    return null;
  }

  return `🎥 [Session video artifact (view in Terragon)](${publicAppUrl()}/task/${threadId})`;
}

function getSdlcStatusCommentMarker(loopId: string): string {
  return `<!-- ${SDLC_STATUS_COMMENT_MARKER_PREFIX}${loopId} -->`;
}

function appendSdlcStatusCommentMarker({
  body,
  loopId,
}: {
  body: string;
  loopId: string;
}): string {
  const marker = getSdlcStatusCommentMarker(loopId);
  if (body.includes(marker)) {
    return body;
  }
  return `${body}\n\n${marker}`;
}

function getSdlcCheckRunExternalId(loopId: string): string {
  return `${SDLC_CHECK_RUN_EXTERNAL_ID_PREFIX}${loopId}`;
}

async function findReconciledCanonicalStatusComment({
  octokit,
  owner,
  repo,
  prNumber,
  loopId,
}: {
  octokit: Awaited<ReturnType<typeof getOctokitForApp>>;
  owner: string;
  repo: string;
  prNumber: number;
  loopId: string;
}) {
  const marker = getSdlcStatusCommentMarker(loopId);
  for (let page = 1; page <= 10; page += 1) {
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      page,
      direction: "desc",
      sort: "updated",
    });
    const match =
      comments.data.find(
        (comment) =>
          typeof comment.body === "string" && comment.body.includes(marker),
      ) ?? null;
    if (match) {
      return match;
    }
    if (comments.data.length < 100) {
      break;
    }
  }
  return null;
}

async function findReconciledCanonicalCheckRun({
  octokit,
  owner,
  repo,
  headSha,
  loopId,
  checkName,
}: {
  octokit: Awaited<ReturnType<typeof getOctokitForApp>>;
  owner: string;
  repo: string;
  headSha: string;
  loopId: string;
  checkName: string;
}) {
  const externalId = getSdlcCheckRunExternalId(loopId);
  for (let page = 1; page <= 10; page += 1) {
    const runs = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      check_name: checkName,
      per_page: 100,
      page,
    });
    const match =
      runs.data.check_runs.find((run) => run.external_id === externalId) ??
      null;
    if (match) {
      return match;
    }
    if (runs.data.check_runs.length < 100) {
      break;
    }
  }
  return null;
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
    throw new Error(`Delivery Loop not found: ${loopId}`);
  }

  const [owner, repo] = parseRepoFullName(repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });
  const canonicalBody = appendSdlcStatusCommentMarker({ body, loopId });

  const existingCommentId = parseGitHubNumericId(loop.canonicalStatusCommentId);
  if (existingCommentId) {
    try {
      const updatedComment = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: existingCommentId,
        body: canonicalBody,
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

  const reconciledComment = await findReconciledCanonicalStatusComment({
    octokit,
    owner,
    repo,
    prNumber,
    loopId,
  });
  if (reconciledComment) {
    const refreshedComment = await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: reconciledComment.id,
      body: canonicalBody,
    });

    await persistSdlcCanonicalStatusCommentReference({
      db,
      loopId,
      commentId: String(refreshedComment.data.id),
      commentNodeId: refreshedComment.data.node_id,
    });

    return {
      commentId: String(refreshedComment.data.id),
      wasCreated: false,
      wasRecreatedAfterMissing: Boolean(existingCommentId),
    };
  }

  const createdComment = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: canonicalBody,
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
    throw new Error(`Delivery Loop not found: ${loopId}`);
  }

  const [owner, repo] = parseRepoFullName(payload.repoFullName);
  const octokit = await getOctokitForApp({ owner, repo });
  const checkRunExternalId = getSdlcCheckRunExternalId(loopId);

  const artifactLink = await buildReviewerSafeVideoArtifactLink(
    payload.artifactR2Key,
    loop.threadId,
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
        external_id: checkRunExternalId,
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
  const headSha = pr.data.head.sha;

  const reconciledCheckRun = await findReconciledCanonicalCheckRun({
    octokit,
    owner,
    repo,
    headSha,
    loopId,
    checkName: payload.title,
  });
  if (reconciledCheckRun) {
    const refreshedCheckRun = await octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: reconciledCheckRun.id,
      external_id: checkRunExternalId,
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
      checkRunId: refreshedCheckRun.data.id,
    });

    return {
      checkRunId: refreshedCheckRun.data.id,
      wasCreated: false,
    };
  }

  const checkRun = await octokit.rest.checks.create({
    owner,
    repo,
    head_sha: headSha,
    name: payload.title,
    external_id: checkRunExternalId,
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
