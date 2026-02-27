import type { ThreadSource, ThreadSourceMetadata } from "@terragon/shared";
import type { DBUserMessage } from "@terragon/shared";
import type {
  CarmackReviewGateOutput,
  DeepReviewGateOutput,
} from "@terragon/shared/model/sdlc-loop";
import { getCurrentBranchName } from "@terragon/sandbox/commands";
import type { ISandboxSession } from "@terragon/sandbox/types";
import { queueFollowUpInternal } from "../follow-up";
import { runCarmackReviewGate } from "./carmack-review-gate";
import { runDeepReviewGate } from "./deep-review-gate";
import { isSdlcLoopEnrollmentAllowedForThread } from "./enrollment";

const SDLC_PRE_PR_MAX_FINDINGS_PER_GATE = 5;
const SDLC_PRE_PR_HEAD_SHA_FALLBACK = "unknown-head-sha";

type SdlcPrePrFinding = {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  detail: string;
  suggestedFix?: string | null;
  isBlocking?: boolean;
};

type SdlcPrePrThreadContext = {
  id: string;
  name: string | null;
  branchName: string | null;
  githubRepoFullName: string;
  githubPRNumber: number | null;
  sourceType: ThreadSource | null;
  sourceMetadata: ThreadSourceMetadata | null;
};

function getBlockingFindings(
  findings: readonly SdlcPrePrFinding[],
): SdlcPrePrFinding[] {
  return findings.filter((finding) => finding.isBlocking !== false);
}

function formatSdlcPrePrFinding(
  finding: SdlcPrePrFinding,
  index: number,
): string {
  const suggestedFix = finding.suggestedFix?.trim();
  return [
    `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`,
    `Category: ${finding.category}`,
    `Detail: ${finding.detail}`,
    suggestedFix ? `Suggested fix: ${suggestedFix}` : null,
  ]
    .filter((line): line is string => !!line)
    .join("\n");
}

function buildSdlcPrePrReviewSummary({
  repoFullName,
  branchName,
  headSha,
  deepReviewFindings,
  carmackReviewFindings,
  deepReviewFailedOrUnstructured,
  carmackReviewFailedOrUnstructured,
  hasExecutionFailure,
}: {
  repoFullName: string;
  branchName: string;
  headSha: string;
  deepReviewFindings: readonly SdlcPrePrFinding[];
  carmackReviewFindings: readonly SdlcPrePrFinding[];
  deepReviewFailedOrUnstructured: boolean;
  carmackReviewFailedOrUnstructured: boolean;
  hasExecutionFailure: boolean;
}): string {
  const sections: string[] = [
    hasExecutionFailure
      ? "SDLC pre-PR review could not fully complete, so PR creation is paused."
      : "SDLC pre-PR review found blocking issues, so PR creation is paused.",
    hasExecutionFailure
      ? "The SDLC loop will automatically retry these checks and re-attempt PR creation."
      : "The SDLC loop has queued an automatic fix pass. Fix all blocking findings below, then continue to checkpoint; PR creation will be retried automatically.",
    `Repository: ${repoFullName}`,
    `Branch: ${branchName}`,
    `Head SHA: ${headSha}`,
  ];

  if (deepReviewFindings.length > 0 || deepReviewFailedOrUnstructured) {
    sections.push(
      "Deep review findings:",
      deepReviewFindings.length > 0
        ? deepReviewFindings
            .slice(0, SDLC_PRE_PR_MAX_FINDINGS_PER_GATE)
            .map(formatSdlcPrePrFinding)
            .join("\n\n")
        : "The deep review gate failed or returned no structured findings.",
    );
  }

  if (carmackReviewFindings.length > 0 || carmackReviewFailedOrUnstructured) {
    sections.push(
      "Carmack review findings:",
      carmackReviewFindings.length > 0
        ? carmackReviewFindings
            .slice(0, SDLC_PRE_PR_MAX_FINDINGS_PER_GATE)
            .map(formatSdlcPrePrFinding)
            .join("\n\n")
        : "The Carmack review gate failed or returned no structured findings.",
    );
  }

  return sections.join("\n\n");
}

function buildSdlcPrePrTaskContext({
  thread,
  branchName,
}: {
  thread: SdlcPrePrThreadContext;
  branchName: string;
}): string {
  return [
    `Thread ID: ${thread.id}`,
    `Task name: ${thread.name ?? "Untitled task"}`,
    `Branch: ${branchName}`,
  ].join("\n");
}

async function getHeadShaOrNull({
  session,
}: {
  session: ISandboxSession;
}): Promise<string | null> {
  try {
    const headSha = (
      await session.runCommand("git rev-parse HEAD", {
        cwd: session.repoDir,
      })
    ).trim();
    return headSha.length > 0 ? headSha : null;
  } catch (error) {
    console.warn("[sdlc-pre-pr-review] failed to resolve head SHA", { error });
    return null;
  }
}

async function queueSdlcPrePrFollowUp({
  userId,
  threadId,
  threadChatId,
  messageText,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  messageText: string;
}) {
  const followUpMessage: DBUserMessage = {
    type: "user",
    model: null,
    parts: [{ type: "text", text: messageText }],
    timestamp: new Date().toISOString(),
  };

  await queueFollowUpInternal({
    userId,
    threadId,
    threadChatId,
    messages: [followUpMessage],
    appendOrReplace: "append",
    source: "www",
  });
}

export async function maybeRunSdlcPrePrReview({
  thread,
  userId,
  threadChatId,
  session,
  diffOutput,
}: {
  thread: SdlcPrePrThreadContext;
  userId: string;
  threadChatId: string;
  session: ISandboxSession;
  diffOutput: string;
}): Promise<boolean> {
  if (thread.githubPRNumber) {
    return true;
  }

  if (thread.sourceType !== "www") {
    return true;
  }

  const enrollmentAllowed = isSdlcLoopEnrollmentAllowedForThread({
    sourceType: thread.sourceType,
    sourceMetadata: thread.sourceMetadata ?? null,
  });
  if (!enrollmentAllowed) {
    return true;
  }

  if (diffOutput === "too-large") {
    await queueSdlcPrePrFollowUp({
      userId,
      threadId: thread.id,
      threadChatId,
      messageText: [
        "SDLC pre-PR review is required before opening a PR, but the current diff is too large to evaluate.",
        "The SDLC loop has queued an automatic scope-reduction pass and will retry PR creation after checkpoint.",
      ].join("\n\n"),
    });
    console.warn(
      "[sdlc-pre-pr-review] blocked PR creation because diff is too large",
      {
        userId,
        threadId: thread.id,
        repoFullName: thread.githubRepoFullName,
      },
    );
    return false;
  }

  const branchName =
    (await getCurrentBranchName(session, session.repoDir).catch(() => null)) ??
    thread.branchName ??
    "unknown-branch";
  const headSha =
    (await getHeadShaOrNull({ session })) ?? SDLC_PRE_PR_HEAD_SHA_FALLBACK;
  const taskContext = buildSdlcPrePrTaskContext({ thread, branchName });

  const [deepReviewResult, carmackReviewResult] = await Promise.allSettled([
    runDeepReviewGate({
      session,
      repoFullName: thread.githubRepoFullName,
      prNumber: null,
      headSha,
      taskContext,
      gitDiff: diffOutput,
    }),
    runCarmackReviewGate({
      session,
      repoFullName: thread.githubRepoFullName,
      prNumber: null,
      headSha,
      taskContext,
      gitDiff: diffOutput,
    }),
  ]);

  const deepReviewOutput: DeepReviewGateOutput | null =
    deepReviewResult.status === "fulfilled" ? deepReviewResult.value : null;
  const carmackReviewOutput: CarmackReviewGateOutput | null =
    carmackReviewResult.status === "fulfilled"
      ? carmackReviewResult.value
      : null;

  const deepReviewFindings = deepReviewOutput
    ? getBlockingFindings(deepReviewOutput.blockingFindings)
    : [];
  const carmackReviewFindings = carmackReviewOutput
    ? getBlockingFindings(carmackReviewOutput.blockingFindings)
    : [];
  const isDeepReviewBlocked = deepReviewOutput
    ? !deepReviewOutput.gatePassed || deepReviewFindings.length > 0
    : false;
  const isCarmackReviewBlocked = carmackReviewOutput
    ? !carmackReviewOutput.gatePassed || carmackReviewFindings.length > 0
    : false;
  const deepReviewExecutionFailed = deepReviewResult.status === "rejected";
  const carmackReviewExecutionFailed =
    carmackReviewResult.status === "rejected";
  const hasExecutionFailure =
    deepReviewExecutionFailed || carmackReviewExecutionFailed;

  if (!isDeepReviewBlocked && !isCarmackReviewBlocked) {
    if (hasExecutionFailure) {
      console.warn(
        "[sdlc-pre-pr-review] gate execution failed without blocking findings; proceeding with PR",
        {
          userId,
          threadId: thread.id,
          repoFullName: thread.githubRepoFullName,
          deepReviewExecutionFailed,
          carmackReviewExecutionFailed,
        },
      );
    }
    return true;
  }

  if (deepReviewExecutionFailed) {
    console.warn("[sdlc-pre-pr-review] deep review gate failed; blocking PR", {
      userId,
      threadId: thread.id,
      repoFullName: thread.githubRepoFullName,
      error: deepReviewResult.reason,
    });
  }
  if (carmackReviewExecutionFailed) {
    console.warn(
      "[sdlc-pre-pr-review] carmack review gate failed; blocking PR",
      {
        userId,
        threadId: thread.id,
        repoFullName: thread.githubRepoFullName,
        error: carmackReviewResult.reason,
      },
    );
  }

  await queueSdlcPrePrFollowUp({
    userId,
    threadId: thread.id,
    threadChatId,
    messageText: buildSdlcPrePrReviewSummary({
      repoFullName: thread.githubRepoFullName,
      branchName,
      headSha,
      deepReviewFindings: isDeepReviewBlocked ? deepReviewFindings : [],
      carmackReviewFindings: isCarmackReviewBlocked
        ? carmackReviewFindings
        : [],
      deepReviewFailedOrUnstructured:
        deepReviewExecutionFailed ||
        (isDeepReviewBlocked && deepReviewFindings.length === 0),
      carmackReviewFailedOrUnstructured:
        carmackReviewExecutionFailed ||
        (isCarmackReviewBlocked && carmackReviewFindings.length === 0),
      hasExecutionFailure,
    }),
  });

  console.log("[sdlc-pre-pr-review] blocked PR creation", {
    userId,
    threadId: thread.id,
    repoFullName: thread.githubRepoFullName,
    deepReviewFindings: deepReviewFindings.length,
    carmackReviewFindings: carmackReviewFindings.length,
    deepReviewExecutionFailed,
    carmackReviewExecutionFailed,
  });

  return false;
}
