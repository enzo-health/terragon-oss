import { db } from "@/lib/db";
import { wrapError, ThreadError } from "@/agent/error";
import { openPullRequestForThread } from "@/agent/pull-request";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import { getPostHogServer } from "@/lib/posthog-server";
import { env } from "@terragon/env/apps-www";
import {
  getCurrentBranchName,
  getGitDiffMaybeCutoff,
  gitDiffStats,
  gitCommitAndPushBranch,
} from "@terragon/sandbox/commands";
import { ISandboxSession } from "@terragon/sandbox/types";
import {
  DBUserMessage,
  DBMessage,
  DBSystemMessage,
  GitDiffStats,
  ThreadInsert,
  ThreadChatInsert,
} from "@terragon/shared";
import { SdlcLoopState } from "@terragon/shared/db/types";
import {
  createImplementationArtifactForHead,
  createPlanArtifactForLoop,
  createPrLinkArtifact,
  createReviewBundleArtifactForHead,
  createUiSmokeArtifactForHead,
  getActiveSdlcLoopForThread,
  getLatestAcceptedArtifact,
  markPlanTasksCompletedByAgent,
  persistCarmackReviewGateResult,
  persistDeepReviewGateResult,
  replacePlanTasksForArtifact,
  transitionSdlcLoopStateWithArtifact,
  transitionSdlcLoopState,
  verifyPlanTaskCompletionForHead,
} from "@terragon/shared/model/sdlc-loop";
import {
  getThread,
  getThreadChat,
  getThreadMinimal,
  updateThread,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import { createGitDiffCheckpoint } from "@terragon/shared/utils/git-diff";
import { sanitizeForJson } from "@terragon/shared/utils/sanitize-json";
import * as z from "zod/v4";
import { runCarmackReviewGate } from "./sdlc-loop/carmack-review-gate";
import { runDeepReviewGate } from "./sdlc-loop/deep-review-gate";
import {
  parsePlanSpec,
  type ParsedPlanSpec as SharedParsedPlanSpec,
} from "./sdlc-loop/parse-plan-spec";
import { queueFollowUpInternal } from "./follow-up";
import { generateCommitMessage } from "./generate-commit-message";
import { runStructuredCodexGateInSandbox } from "./sdlc-loop/sandbox-codex-gate";
import { sendSystemMessage } from "./send-system-message";

const SDLC_UI_SMOKE_PROMPT_VERSION = 1;
const SDLC_REVIEW_GATE_MODEL = "gpt-5.3-codex-medium";
const SDLC_UI_SMOKE_GATE_MODEL = "gpt-5.3-codex-medium";
const SDLC_PLAN_TOOL_NAMES = {
  EXIT_PLAN_MODE: "ExitPlanMode",
  WRITE: "Write",
} as const;
const SDLC_TASK_UPDATE_PAYLOAD_KEYS = {
  TASK_UPDATES: "taskUpdates",
  COMPLETED_TASKS: "completedTasks",
} as const;

const sdlcUiSmokeGateOutputSchema = z.object({
  gatePassed: z.boolean(),
  summary: z.string().trim().min(1),
  blockingIssues: z.array(z.string().trim().min(1)).default([]),
});

type SdlcUiSmokeGateOutput = z.infer<typeof sdlcUiSmokeGateOutputSchema>;

const sdlcImplementingStates: ReadonlySet<SdlcLoopState> = new Set([
  "implementing",
  "blocked_on_agent_fixes",
  "blocked_on_ci",
  "blocked_on_review_threads",
]);

type SdlcPhaseGateEvaluation = {
  gatePassed: boolean;
  reasons: string[];
};

function hasCodeDiffArtifact(diffOutput: string | null): boolean {
  if (diffOutput === "too-large") {
    return true;
  }
  if (typeof diffOutput !== "string") {
    return false;
  }
  return diffOutput.trim().length > 0;
}

function extractLatestTopLevelAgentText(
  messages: DBMessage[] | null,
): string | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  // Merge the last consecutive run of top-level agent messages.
  // ACP transports (e.g. Codex) stream word-by-word, so a single response
  // becomes many small agent messages that must be concatenated.
  const textParts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.type !== "agent" || message.parent_tool_use_id !== null) {
      if (textParts.length > 0) break; // end of consecutive run
      continue;
    }
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
    if (text.length > 0) {
      textParts.unshift(text); // prepend to maintain order
    }
  }

  return textParts.length > 0 ? textParts.join("") : null;
}

type ParsedPlanSpecWithSource = SharedParsedPlanSpec & {
  source: "exit_plan_mode" | "write_tool" | "agent_text";
};

function findPlanFromWriteToolCall({
  messages,
  exitPlanModeToolId,
}: {
  messages: DBMessage[];
  exitPlanModeToolId: string;
}): string | null {
  let exitPlanModeIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message?.type === "tool-call" &&
      message.name === SDLC_PLAN_TOOL_NAMES.EXIT_PLAN_MODE &&
      message.id === exitPlanModeToolId
    ) {
      exitPlanModeIndex = i;
      break;
    }
  }
  if (exitPlanModeIndex === -1) {
    return null;
  }

  for (let i = exitPlanModeIndex - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (message.type === "user") {
      break;
    }
    if (
      message.type === "tool-call" &&
      message.name === SDLC_PLAN_TOOL_NAMES.WRITE
    ) {
      const filePath = message.parameters?.file_path;
      const content = message.parameters?.content;
      if (
        typeof filePath === "string" &&
        /plans\/[^/]+\.md$/.test(filePath) &&
        typeof content === "string" &&
        content.trim().length > 0
      ) {
        return content;
      }
    }
  }

  return null;
}

export function extractLatestPlanText(messages: DBMessage[] | null): {
  text: string;
  source: ParsedPlanSpecWithSource["source"];
} | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  // Priority 1: ExitPlanMode tool call (with optional Write companion)
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      !message ||
      message.type !== "tool-call" ||
      message.name !== SDLC_PLAN_TOOL_NAMES.EXIT_PLAN_MODE
    ) {
      continue;
    }
    if (
      typeof message.parameters?.plan === "string" &&
      message.parameters.plan.trim().length > 0
    ) {
      return {
        text: message.parameters.plan.trim(),
        source: "exit_plan_mode",
      };
    }
    const writePlan = findPlanFromWriteToolCall({
      messages,
      exitPlanModeToolId: message.id,
    });
    if (writePlan) {
      return {
        text: writePlan.trim(),
        source: "write_tool",
      };
    }
  }

  // Priority 2: Standalone Write to plans/*.md (no ExitPlanMode required).
  // Enables ACP agents that can Write but cannot ExitPlanMode.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.type === "user") break;
    if (
      message.type === "tool-call" &&
      message.name === SDLC_PLAN_TOOL_NAMES.WRITE
    ) {
      const filePath = message.parameters?.file_path;
      const content = message.parameters?.content;
      if (
        typeof filePath === "string" &&
        /plans\/[^/]+\.md$/.test(filePath) &&
        typeof content === "string" &&
        content.trim().length > 0
      ) {
        return { text: content.trim(), source: "write_tool" };
      }
    }
  }

  // Priority 3: Agent text fallback
  const latestAgentText = extractLatestTopLevelAgentText(messages);
  if (!latestAgentText) {
    return null;
  }
  return {
    text: latestAgentText,
    source: "agent_text",
  };
}

function parsePlanSpecWithSource({
  text,
  source,
}: {
  text: string;
  source: ParsedPlanSpecWithSource["source"];
}):
  | { ok: true; plan: ParsedPlanSpecWithSource; diagnostic: string }
  | { ok: false; diagnostic: string } {
  const result = parsePlanSpec(text);
  if (!result.ok) return { ok: false, diagnostic: result.diagnostic };
  return {
    ok: true,
    plan: { ...result.plan, source },
    diagnostic: result.diagnostic,
  };
}

function parseTaskCompletionUpdatesFromText({
  text,
  headSha,
  changedFiles,
}: {
  text: string | null;
  headSha: string;
  changedFiles: string[];
}): Array<{
  stableTaskId: string;
  status?: "done" | "skipped" | "blocked";
  evidence: {
    headSha: string;
    note?: string | null;
    changedFiles?: string[] | null;
  };
}> {
  const updatesByTaskId = new Map<
    string,
    {
      stableTaskId: string;
      status?: "done" | "skipped" | "blocked";
      evidence: {
        headSha: string;
        note?: string | null;
        changedFiles?: string[] | null;
      };
    }
  >();

  const trimmed = text?.trim() ?? "";
  if (trimmed.length > 0) {
    const fencedJsonMatches = [
      ...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi),
    ];
    const jsonCandidates = [
      trimmed,
      ...fencedJsonMatches.map((m) => m[1] ?? ""),
    ];
    for (const candidate of jsonCandidates) {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        const updates = Array.isArray(
          parsed[SDLC_TASK_UPDATE_PAYLOAD_KEYS.TASK_UPDATES],
        )
          ? (parsed[SDLC_TASK_UPDATE_PAYLOAD_KEYS.TASK_UPDATES] as unknown[])
          : Array.isArray(parsed[SDLC_TASK_UPDATE_PAYLOAD_KEYS.COMPLETED_TASKS])
            ? (parsed[
                SDLC_TASK_UPDATE_PAYLOAD_KEYS.COMPLETED_TASKS
              ] as unknown[])
            : null;
        if (!updates) {
          continue;
        }
        for (const update of updates) {
          if (!update || typeof update !== "object") {
            continue;
          }
          const typed = update as {
            stableTaskId?: unknown;
            status?: unknown;
            note?: unknown;
            changedFiles?: unknown;
          };
          if (
            typeof typed.stableTaskId !== "string" ||
            !typed.stableTaskId.trim()
          ) {
            continue;
          }
          const status =
            typed.status === "done" ||
            typed.status === "skipped" ||
            typed.status === "blocked"
              ? typed.status
              : "done";
          const changedFilesFromUpdate = Array.isArray(typed.changedFiles)
            ? typed.changedFiles.filter(
                (file): file is string =>
                  typeof file === "string" && file.trim().length > 0,
              )
            : changedFiles;
          updatesByTaskId.set(typed.stableTaskId.trim(), {
            stableTaskId: typed.stableTaskId.trim(),
            status,
            evidence: {
              headSha,
              note:
                typeof typed.note === "string" && typed.note.trim().length > 0
                  ? typed.note.trim()
                  : "task completion acknowledged in checkpoint",
              changedFiles: changedFilesFromUpdate,
            },
          });
        }
        break;
      } catch {
        continue;
      }
    }

    const checklistMatches = [
      ...trimmed.matchAll(/-\s*\[[xX]\]\s*([a-z0-9][a-z0-9-_]*)/g),
    ];
    for (const match of checklistMatches) {
      const taskId = match[1]?.trim();
      if (!taskId) {
        continue;
      }
      if (updatesByTaskId.has(taskId)) {
        continue;
      }
      updatesByTaskId.set(taskId, {
        stableTaskId: taskId,
        status: "done",
        evidence: {
          headSha,
          note: "marked complete via checklist",
          changedFiles,
        },
      });
    }
  }

  return [...updatesByTaskId.values()];
}

function evaluatePlanningPhaseGate({
  diffOutput,
  planParseResult,
  isAcpAgent,
}: {
  diffOutput: string | null;
  planParseResult:
    | { ok: true; plan: ParsedPlanSpecWithSource; diagnostic: string }
    | { ok: false; diagnostic: string }
    | null;
  isAcpAgent: boolean;
}): SdlcPhaseGateEvaluation {
  const reasons: string[] = [];
  if (hasCodeDiffArtifact(diffOutput)) {
    reasons.push(
      "Planning phase requires zero code edits. Revert local changes and submit a plan-only response.",
    );
  }

  if (!planParseResult) {
    reasons.push(
      isAcpAgent
        ? "No plan artifact found. Output a ```json code block with a tasks[] array in your response."
        : "No plan artifact found. Use ExitPlanMode or output a structured plan JSON with a tasks[] array.",
    );
  } else if (!planParseResult.ok) {
    reasons.push(planParseResult.diagnostic);
  } else if (planParseResult.plan.tasks.length < 1) {
    reasons.push(
      "Plan artifact is missing tasks. Include at least one actionable task with a title.",
    );
  } else if (
    planParseResult.ok &&
    planParseResult.plan.source === "agent_text"
  ) {
    const hasAnyDescription = planParseResult.plan.tasks.some(
      (t) => t.description !== null,
    );
    if (planParseResult.plan.tasks.length < 2 && !hasAnyDescription) {
      reasons.push(
        "Plan from agent text is too sparse. Output a JSON plan in a ```json code block.",
      );
    }
  }

  return {
    gatePassed: reasons.length === 0,
    reasons,
  };
}

/**
 * Detect whether the agent explicitly signaled phase completion via
 * `"phaseComplete": true` in a structured JSON block. Until this signal
 * appears, checkpoints are bookkeeping-only — no gate evaluation, no
 * follow-up messages, no loop.
 */
/** Pre-lowercased aliases for the phase-complete signal key. */
const PHASE_COMPLETE_ALIASES: ReadonlySet<string> = new Set([
  "phasecomplete",
  "phase_complete",
  "phasecompleted",
  "phase_completed",
  "isphasecomplete",
  "is_phase_complete",
]);

function detectPhaseCompleteSignal(messages: DBMessage[] | null): boolean {
  const agentText = extractLatestTopLevelAgentText(messages);
  if (!agentText) return false;

  const trimmed = agentText.trim();
  const fencedJsonMatches = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const jsonCandidates = [trimmed, ...fencedJsonMatches.map((m) => m[1] ?? "")];

  for (const candidate of jsonCandidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const lowerKeys = new Map(
        Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]),
      );
      for (const alias of PHASE_COMPLETE_ALIASES) {
        if (lowerKeys.get(alias) === true) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function buildSdlcFixFollowUpMessage({
  heading,
  details,
}: {
  heading: string;
  details: string[];
}): DBUserMessage {
  return {
    type: "user",
    model: null,
    timestamp: new Date().toISOString(),
    parts: [
      {
        type: "text",
        text: [heading, ...details].join("\n\n"),
      },
    ],
  };
}

async function queueSdlcFollowUpMessage({
  userId,
  threadId,
  threadChatId,
  heading,
  details,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  heading: string;
  details: string[];
}) {
  await queueFollowUpInternal({
    userId,
    threadId,
    threadChatId,
    messages: [
      buildSdlcFixFollowUpMessage({
        heading,
        details,
      }),
    ],
    appendOrReplace: "append",
    source: "www",
  });
}

/**
 * Fire `implementation_gate_blocked`, re-fetch the loop, and escalate to
 * `blocked_on_human_feedback` if the fix-attempt limit was reached.
 * Returns `true` if escalated (caller should return early).
 */
async function transitionImplementationGateBlocked({
  db: dbConn,
  userId,
  threadId,
  threadChatId,
  loopId,
  escalationDetails,
}: {
  db: typeof db;
  userId: string;
  threadId: string;
  threadChatId: string;
  loopId: string;
  escalationDetails: string[];
}): Promise<boolean> {
  const outcome = await transitionSdlcLoopState({
    db: dbConn,
    loopId,
    transitionEvent: "implementation_gate_blocked",
  });
  if (outcome === "stale_noop" || outcome === "terminal_noop") {
    return true;
  }
  const refreshedLoop = await getActiveSdlcLoopForThread({
    db: dbConn,
    userId,
    threadId,
  });
  if (refreshedLoop?.state === "blocked_on_human_feedback") {
    await queueSdlcFollowUpMessage({
      userId,
      threadId,
      threadChatId,
      heading: "SDLC implementation: max retries exceeded.",
      details: escalationDetails,
    });
    return true;
  }
  return false;
}

async function getHeadShaOrThrow(session: ISandboxSession): Promise<string> {
  const headSha = (
    await session.runCommand("git rev-parse HEAD", {
      cwd: session.repoDir,
    })
  ).trim();
  if (!headSha) {
    throw new Error("Unable to resolve git HEAD SHA");
  }
  return headSha;
}

async function listChangedFiles({
  session,
  baseBranch,
}: {
  session: ISandboxSession;
  baseBranch: string;
}) {
  const output = await session.runCommand(
    `git diff --name-only ${baseBranch}...HEAD`,
    {
      cwd: session.repoDir,
    },
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasUiSurfaceChanges(files: string[]): boolean {
  return files.some((file) => {
    if (file.startsWith("apps/www/")) {
      return true;
    }
    if (file.startsWith("packages/elements/")) {
      return true;
    }
    return /\.(tsx|jsx|css|scss|sass|less|html)$/.test(file);
  });
}

async function runUiSmokeGate({
  session,
  repoFullName,
  branchName,
  headSha,
  changedFiles,
}: {
  session: ISandboxSession;
  repoFullName: string;
  branchName: string;
  headSha: string;
  changedFiles: string[];
}): Promise<SdlcUiSmokeGateOutput> {
  if (!hasUiSurfaceChanges(changedFiles)) {
    return {
      gatePassed: true,
      summary: "No UI-facing files changed; browser smoke gate skipped.",
      blockingIssues: [],
    };
  }

  const prompt = [
    "You are the SDLC UI smoke gate.",
    "Use the existing agent-browser runtime path only (no Playwright suite).",
    "Run a focused browser smoke check against the changed UI paths and verify no obvious runtime/UI breakage.",
    "Return strict JSON only.",
    "",
    `Repository: ${repoFullName}`,
    `Branch: ${branchName}`,
    `Head SHA: ${headSha}`,
    `Prompt Version: ${SDLC_UI_SMOKE_PROMPT_VERSION}`,
    "",
    "Changed files:",
    changedFiles.map((file) => `- ${file}`).join("\n"),
    "",
    "Output shape:",
    '{ "gatePassed": boolean, "summary": string, "blockingIssues": string[] }',
  ].join("\n");

  return await runStructuredCodexGateInSandbox({
    session,
    gateName: "ui-smoke",
    model: SDLC_UI_SMOKE_GATE_MODEL,
    schema: sdlcUiSmokeGateOutputSchema,
    prompt,
  });
}

function formatReviewFindings({
  label,
  findings,
}: {
  label: string;
  findings: Array<{
    title: string;
    severity: "critical" | "high" | "medium" | "low";
    detail: string;
    category: string;
  }>;
}) {
  if (findings.length === 0) {
    return null;
  }
  return [
    `${label}:`,
    ...findings.slice(0, 8).map((finding, index) => {
      return `${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title} (${finding.category})\n${finding.detail}`;
    }),
  ].join("\n");
}

async function maybeRunStrictSdlcCheckpointPipeline({
  threadId,
  threadChatId,
  userId,
  session,
  createPR,
  prType,
  diffOutput,
}: {
  threadId: string;
  threadChatId: string;
  userId: string;
  session: ISandboxSession;
  createPR: boolean;
  prType: "draft" | "ready";
  diffOutput: string | null;
}) {
  const activeLoop = await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });
  if (!activeLoop) {
    return false;
  }

  if (activeLoop.state === "blocked_on_human_feedback") {
    return true;
  }

  if (activeLoop.state === "planning") {
    const threadChat = await getThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
    });
    const isAcpAgent =
      threadChat?.agent === "codex" ||
      threadChat?.agent === "amp" ||
      threadChat?.agent === "opencode";
    const extractedPlan = extractLatestPlanText(threadChat?.messages ?? null);
    const planParseResult = extractedPlan
      ? parsePlanSpecWithSource({
          text: extractedPlan.text,
          source: extractedPlan.source,
        })
      : null;
    const planningGate = evaluatePlanningPhaseGate({
      diffOutput,
      planParseResult,
      isAcpAgent,
    });
    if (!planningGate.gatePassed) {
      await transitionSdlcLoopState({
        db,
        loopId: activeLoop.id,
        transitionEvent: "plan_gate_blocked",
      });
      // Check if max retries exceeded → blocked_on_human_feedback
      const refreshed = await getActiveSdlcLoopForThread({
        db,
        userId,
        threadId,
      });
      if (refreshed?.state === "blocked_on_human_feedback") {
        await queueSdlcFollowUpMessage({
          userId,
          threadId,
          threadChatId,
          heading: "SDLC planning: max retries exceeded.",
          details: [
            "The planning gate has failed too many times.",
            "Human intervention is required to unblock. Review the plan format and retry.",
          ],
        });
        return true;
      }
      await queueSdlcFollowUpMessage({
        userId,
        threadId,
        threadChatId,
        heading: "SDLC planning gate blocked.",
        details: planningGate.reasons,
      });
      return true;
    }

    if (!planParseResult || !planParseResult.ok) {
      console.warn(
        "SDLC planning gate: plan parse failed or returned no result",
        {
          threadId,
          threadChatId,
          hasPlanParseResult: !!planParseResult,
          parseOk: planParseResult?.ok ?? null,
          parseDiagnostic:
            planParseResult && !planParseResult.ok
              ? planParseResult.diagnostic
              : null,
        },
      );
      return true;
    }
    const parsedPlan = planParseResult.plan;

    const nextLoopVersion =
      typeof activeLoop.loopVersion === "number" &&
      Number.isFinite(activeLoop.loopVersion)
        ? Math.max(activeLoop.loopVersion, 0) + 1
        : 1;
    const planArtifactStatus =
      activeLoop.planApprovalPolicy === "human_required"
        ? "generated"
        : "accepted";
    const planArtifact = await createPlanArtifactForLoop({
      db,
      loopId: activeLoop.id,
      loopVersion: nextLoopVersion,
      status: planArtifactStatus,
      generatedBy: "agent",
      payload: {
        planText: parsedPlan.planText,
        tasks: parsedPlan.tasks,
        source: parsedPlan.source,
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: activeLoop.id,
      artifactId: planArtifact.id,
      tasks: parsedPlan.tasks,
    });

    if (activeLoop.planApprovalPolicy === "human_required") {
      await queueSdlcFollowUpMessage({
        userId,
        threadId,
        threadChatId,
        heading:
          "SDLC plan captured. Human approval required before implementation.",
        details: [
          "Use the Approve action to move from planning to implementing.",
          "No code changes should be made until approval is recorded.",
        ],
      });
      return true;
    }

    const transitioned = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: activeLoop.id,
      artifactId: planArtifact.id,
      expectedPhase: "planning",
      transitionEvent: "plan_completed",
      loopVersion: nextLoopVersion,
    });
    if (transitioned === "updated") {
      await queueSdlcFollowUpMessage({
        userId,
        threadId,
        threadChatId,
        heading:
          "SDLC phase advanced to implementing. Execute the approved plan now.",
        details: [
          "Implement the planned changes directly in code.",
          "After implementing, run checkpoint again to trigger mandatory review, UI smoke, and PR steps.",
        ],
      });
      await updateThreadChat({
        db,
        userId,
        threadId,
        threadChatId,
        updates: { sessionId: null },
      });
    } else {
      await queueSdlcFollowUpMessage({
        userId,
        threadId,
        threadChatId,
        heading: "SDLC planning gate could not transition to implementing.",
        details: [
          "Plan artifact was saved, but transition preconditions were not met.",
          "Retry checkpoint or re-approve the plan.",
        ],
      });
    }
    return true;
  }

  if (activeLoop.state === "pr_babysitting") {
    return true;
  }

  const refreshedThread = await getThread({ db, threadId, userId });
  if (!refreshedThread) {
    throw new ThreadError("unknown-error", "Thread not found", null);
  }

  const headSha = await getHeadShaOrThrow(session);
  const branchName =
    (await getCurrentBranchName(session, session.repoDir).catch(() => null)) ??
    refreshedThread.branchName ??
    "unknown-branch";
  const loopVersionForGateRun =
    typeof activeLoop.loopVersion === "number" &&
    Number.isFinite(activeLoop.loopVersion)
      ? Math.max(activeLoop.loopVersion, 0) + 1
      : 1;
  const changedFiles = await listChangedFiles({
    session,
    baseBranch: refreshedThread.repoBaseBranchName,
  });

  if (sdlcImplementingStates.has(activeLoop.state)) {
    // Sub-state transitions (blocked_on_agent_fixes, etc.)
    if (
      activeLoop.state === "blocked_on_agent_fixes" ||
      activeLoop.state === "blocked_on_ci" ||
      activeLoop.state === "blocked_on_review_threads"
    ) {
      await transitionSdlcLoopState({
        db,
        loopId: activeLoop.id,
        transitionEvent: "implementation_progress",
        headSha,
        loopVersion: loopVersionForGateRun,
        now: new Date(),
      });
    }

    // Always fetch the plan artifact (needed for task bookkeeping)
    const acceptedPlanArtifact = await getLatestAcceptedArtifact({
      db,
      loopId: activeLoop.id,
      phase: "planning",
      includeApprovedForPlanning: true,
    });
    if (!acceptedPlanArtifact) {
      await queueSdlcFollowUpMessage({
        userId,
        threadId,
        threadChatId,
        heading: "SDLC implementation gate blocked.",
        details: [
          "No accepted/approved plan artifact is available for this loop.",
          "Return to planning and regenerate a structured plan.",
        ],
      });
      return true;
    }

    // Always run task bookkeeping (every checkpoint)
    const threadChat = await getThreadChat({
      db,
      userId,
      threadId,
      threadChatId,
    });
    const latestAgentText = extractLatestTopLevelAgentText(
      threadChat?.messages ?? null,
    );
    const completionUpdates = parseTaskCompletionUpdatesFromText({
      text: latestAgentText,
      headSha,
      changedFiles,
    });
    await markPlanTasksCompletedByAgent({
      db,
      loopId: activeLoop.id,
      artifactId: acceptedPlanArtifact.id,
      completions: completionUpdates,
    });

    // Check for agent completion signal — until the agent signals
    // phaseComplete, this is a progress checkpoint only (no gate, no follow-up)
    const phaseComplete = detectPhaseCompleteSignal(
      threadChat?.messages ?? null,
    );

    if (!phaseComplete) {
      // Agent hasn't signaled completion — silent return
      return true;
    }

    // Agent signaled phaseComplete — NOW evaluate the implementation gate
    if (!hasCodeDiffArtifact(diffOutput)) {
      const escalated = await transitionImplementationGateBlocked({
        db,
        userId,
        threadId,
        threadChatId,
        loopId: activeLoop.id,
        escalationDetails: ["Human intervention required."],
      });
      if (!escalated) {
        await queueSdlcFollowUpMessage({
          userId,
          threadId,
          threadChatId,
          heading:
            "SDLC implementation: completion signaled but no code changes detected.",
          details: [
            "You indicated phaseComplete but no git diff was found.",
            "Write code and signal phaseComplete again when done.",
          ],
        });
      }
      return true;
    }

    // Verify all tasks are complete
    const verifiedTaskCompletion = await verifyPlanTaskCompletionForHead({
      db,
      loopId: activeLoop.id,
      artifactId: acceptedPlanArtifact.id,
      headSha,
    });
    if (!verifiedTaskCompletion.gatePassed) {
      const reasons: string[] = [];
      if (verifiedTaskCompletion.totalTasks === 0) {
        reasons.push(
          "No planned tasks were found for the active plan artifact.",
        );
      }
      if (verifiedTaskCompletion.incompleteTaskIds.length > 0) {
        reasons.push(
          `Incomplete tasks: ${verifiedTaskCompletion.incompleteTaskIds.join(", ")}`,
        );
      }
      if (verifiedTaskCompletion.invalidEvidenceTaskIds.length > 0) {
        reasons.push(
          `Tasks with stale/missing head-linked evidence: ${verifiedTaskCompletion.invalidEvidenceTaskIds.join(", ")}`,
        );
      }
      if (reasons.length === 0) {
        reasons.push(
          "Task verifier rejected completion evidence. Update task completion evidence and rerun checkpoint.",
        );
      }

      const escalated = await transitionImplementationGateBlocked({
        db,
        userId,
        threadId,
        threadChatId,
        loopId: activeLoop.id,
        escalationDetails: [
          "Human intervention required. The implementation gate has failed too many times.",
        ],
      });
      if (!escalated) {
        await queueSdlcFollowUpMessage({
          userId,
          threadId,
          threadChatId,
          heading:
            "SDLC implementation: completion signaled but tasks incomplete.",
          details: reasons,
        });
      }
      return true;
    }

    // All gates pass — create artifact and transition to reviewing
    const implementationArtifact = await createImplementationArtifactForHead({
      db,
      loopId: activeLoop.id,
      headSha,
      loopVersion: loopVersionForGateRun,
      payload: {
        headSha,
        summary: `Implementation snapshot for ${headSha.slice(0, 12)}`,
        changedFiles,
        completedTaskIds: completionUpdates
          .filter((update) => update.status !== "blocked")
          .map((update) => update.stableTaskId),
      },
      generatedBy: "system",
      status: "accepted",
    });

    const implementationTransition = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: activeLoop.id,
      artifactId: implementationArtifact.id,
      expectedPhase: "implementing",
      transitionEvent: "implementation_completed",
      headSha,
      loopVersion: loopVersionForGateRun,
    });
    if (implementationTransition !== "updated") {
      await queueSdlcFollowUpMessage({
        userId,
        threadId,
        threadChatId,
        heading: "SDLC implementation gate could not transition to reviewing.",
        details: [
          "Implementation artifact was persisted, but transition preconditions were not met.",
          "Retry checkpoint to continue.",
        ],
      });
      return true;
    }
  }

  const refreshedLoopAfterImplementation = await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });
  if (!refreshedLoopAfterImplementation) {
    return true;
  }

  const shouldRunReviewPhase =
    refreshedLoopAfterImplementation.state === "reviewing";

  if (shouldRunReviewPhase) {
    const reviewLoop = refreshedLoopAfterImplementation;

    if (!diffOutput || diffOutput === "too-large") {
      await transitionSdlcLoopState({
        db,
        loopId: reviewLoop.id,
        transitionEvent: "review_blocked",
        now: new Date(),
      });
      await queueSdlcFollowUpMessage({
        userId,
        threadId,
        threadChatId,
        heading: "SDLC review phase blocked: diff is not reviewable.",
        details: [
          "Deep + Carmack reviews are mandatory before PR actions.",
          "Reduce the diff scope and rerun checkpoint.",
        ],
      });
      return true;
    }

    const taskContext = [
      `Thread ID: ${threadId}`,
      `Task name: ${refreshedThread.name ?? "Untitled task"}`,
      `Branch: ${branchName}`,
    ].join("\n");

    let deepResult: Awaited<
      ReturnType<typeof persistDeepReviewGateResult>
    > | null = null;
    let deepError: string | null = null;
    try {
      const deepOutput = await runDeepReviewGate({
        session,
        repoFullName: refreshedThread.githubRepoFullName,
        prNumber: refreshedThread.githubPRNumber,
        headSha,
        taskContext,
        gitDiff: diffOutput,
        model: SDLC_REVIEW_GATE_MODEL,
      });
      deepResult = await persistDeepReviewGateResult({
        db,
        loopId: reviewLoop.id,
        headSha,
        loopVersion: loopVersionForGateRun,
        model: SDLC_REVIEW_GATE_MODEL,
        rawOutput: deepOutput,
        updateLoopState: false,
      });
    } catch (error) {
      deepError = error instanceof Error ? error.message : "Unknown error";
      console.error("[sdlc-loop] deep review gate execution failed", {
        loopId: reviewLoop.id,
        threadId,
        error,
      });
    }

    let carmackResult: Awaited<
      ReturnType<typeof persistCarmackReviewGateResult>
    > | null = null;
    let carmackError: string | null = null;
    try {
      const carmackOutput = await runCarmackReviewGate({
        session,
        repoFullName: refreshedThread.githubRepoFullName,
        prNumber: refreshedThread.githubPRNumber,
        headSha,
        taskContext,
        gitDiff: diffOutput,
        model: SDLC_REVIEW_GATE_MODEL,
      });
      carmackResult = await persistCarmackReviewGateResult({
        db,
        loopId: reviewLoop.id,
        headSha,
        loopVersion: loopVersionForGateRun,
        model: SDLC_REVIEW_GATE_MODEL,
        rawOutput: carmackOutput,
        updateLoopState: false,
      });
    } catch (error) {
      carmackError = error instanceof Error ? error.message : "Unknown error";
      console.error("[sdlc-loop] carmack review gate execution failed", {
        loopId: reviewLoop.id,
        threadId,
        error,
      });
    }

    const deepBlocked =
      deepError !== null ||
      !deepResult ||
      deepResult.status !== "passed" ||
      deepResult.unresolvedBlockingFindings > 0;
    const carmackBlocked =
      carmackError !== null ||
      !carmackResult ||
      carmackResult.status !== "passed" ||
      carmackResult.unresolvedBlockingFindings > 0;

    const reviewArtifact = await createReviewBundleArtifactForHead({
      db,
      loopId: reviewLoop.id,
      headSha,
      loopVersion: loopVersionForGateRun,
      payload: {
        headSha,
        deepRunId: deepResult?.runId ?? null,
        carmackRunId: carmackResult?.runId ?? null,
        deepBlockingFindings: deepResult?.unresolvedBlockingFindings ?? 0,
        carmackBlockingFindings: carmackResult?.unresolvedBlockingFindings ?? 0,
        gatePassed: !deepBlocked && !carmackBlocked,
        summary:
          !deepBlocked && !carmackBlocked
            ? "Deep and Carmack review gates passed."
            : "Deep/Carmack review gates reported blockers.",
      },
      generatedBy: "system",
      status: "accepted",
    });
    if (deepBlocked || carmackBlocked) {
      await transitionSdlcLoopState({
        db,
        loopId: reviewLoop.id,
        transitionEvent: "review_blocked",
        now: new Date(),
      });

      const reviewSections = [
        deepError ? `Deep review failed to execute: ${deepError}` : null,
        carmackError
          ? `Carmack review failed to execute: ${carmackError}`
          : null,
        deepResult
          ? formatReviewFindings({
              label: "Deep review blocking findings",
              findings: deepResult.findings.filter(
                (finding) => finding.isBlocking !== false,
              ),
            })
          : null,
        carmackResult
          ? formatReviewFindings({
              label: "Carmack review blocking findings",
              findings: carmackResult.findings.filter(
                (finding) => finding.isBlocking !== false,
              ),
            })
          : null,
      ].filter((section): section is string => Boolean(section));

      await queueSdlcFollowUpMessage({
        userId,
        threadId,
        threadChatId,
        heading:
          "SDLC review phase blocked. Fix all blocking Deep/Carmack findings, then rerun checkpoint.",
        details:
          reviewSections.length > 0
            ? reviewSections
            : [
                "Review gates reported blockers but did not return structured findings.",
              ],
      });
      return true;
    }

    await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: reviewLoop.id,
      artifactId: reviewArtifact.id,
      expectedPhase: "reviewing",
      transitionEvent: "review_passed",
      headSha,
      loopVersion: loopVersionForGateRun,
      now: new Date(),
    });
  }

  const loopAfterReview = await getActiveSdlcLoopForThread({
    db,
    userId,
    threadId,
  });
  if (!loopAfterReview) {
    return true;
  }
  if (loopAfterReview.state !== "ui_testing") {
    return true;
  }

  let uiSmokeResult: SdlcUiSmokeGateOutput | null = null;
  let uiSmokeError: string | null = null;
  try {
    uiSmokeResult = await runUiSmokeGate({
      session,
      repoFullName: refreshedThread.githubRepoFullName,
      branchName,
      headSha,
      changedFiles,
    });
  } catch (error) {
    uiSmokeError = error instanceof Error ? error.message : "Unknown error";
    console.error("[sdlc-loop] ui smoke gate execution failed", {
      loopId: loopAfterReview.id,
      threadId,
      error,
    });
  }

  const uiSmokeBlocked =
    uiSmokeError !== null || !uiSmokeResult || !uiSmokeResult.gatePassed;
  const uiSmokeArtifact = await createUiSmokeArtifactForHead({
    db,
    loopId: loopAfterReview.id,
    headSha,
    loopVersion: loopVersionForGateRun,
    payload: {
      headSha,
      gatePassed: !uiSmokeBlocked,
      summary:
        uiSmokeResult?.summary ??
        (uiSmokeError
          ? `UI smoke gate failed: ${uiSmokeError}`
          : "Unknown UI smoke outcome"),
      blockingIssues: uiSmokeResult?.blockingIssues ?? [],
      changedFiles,
    },
    generatedBy: "system",
    status: "accepted",
  });
  if (uiSmokeBlocked) {
    await transitionSdlcLoopState({
      db,
      loopId: loopAfterReview.id,
      transitionEvent: "ui_smoke_failed",
      now: new Date(),
    });
    await queueSdlcFollowUpMessage({
      userId,
      threadId,
      threadChatId,
      heading:
        "SDLC UI smoke phase blocked. Run browser smoke checks and fix the issues.",
      details: [
        uiSmokeError
          ? `UI smoke gate failed to execute: ${uiSmokeError}`
          : (uiSmokeResult?.summary ?? "UI smoke gate reported failures."),
        ...(uiSmokeResult?.blockingIssues?.map((issue) => `- ${issue}`) ?? []),
      ],
    });
    return true;
  }

  const uiTransition = await transitionSdlcLoopStateWithArtifact({
    db,
    loopId: loopAfterReview.id,
    artifactId: uiSmokeArtifact.id,
    expectedPhase: "ui_testing",
    transitionEvent: "ui_smoke_passed",
    headSha,
    loopVersion: loopVersionForGateRun,
    now: new Date(),
  });
  if (uiTransition !== "updated") {
    await queueSdlcFollowUpMessage({
      userId,
      threadId,
      threadChatId,
      heading: "SDLC UI gate could not transition to PR linking.",
      details: [
        "UI smoke artifact was persisted, but transition preconditions were not met.",
        "Retry checkpoint to continue.",
      ],
    });
    return true;
  }

  if (
    !createPR &&
    !refreshedThread.githubPRNumber &&
    !loopAfterReview.prNumber
  ) {
    await queueSdlcFollowUpMessage({
      userId,
      threadId,
      threadChatId,
      heading: "SDLC PR phase is waiting: automatic PR creation is disabled.",
      details: [
        "Create or link a PR for this thread, then checkpoint again to enter PR babysitting.",
      ],
    });
    return true;
  }

  if (createPR || refreshedThread.githubPRNumber || loopAfterReview.prNumber) {
    await openPullRequestForThread({
      userId,
      threadId,
      threadChatId,
      prType,
      skipCommitAndPush: true,
      session,
    });
  }

  const [linkedLoop, threadAfterPr] = await Promise.all([
    getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    }),
    getThread({ db, threadId, userId }),
  ]);
  const prNumber =
    linkedLoop?.prNumber ?? threadAfterPr?.githubPRNumber ?? null;
  if (linkedLoop && typeof prNumber === "number") {
    const prArtifact = await createPrLinkArtifact({
      db,
      loopId: linkedLoop.id,
      loopVersion: loopVersionForGateRun,
      payload: {
        repoFullName: refreshedThread.githubRepoFullName,
        prNumber,
        pullRequestUrl: `https://github.com/${refreshedThread.githubRepoFullName}/pull/${prNumber}`,
        operation: refreshedThread.githubPRNumber ? "updated" : "linked",
      },
      generatedBy: "system",
      status: "accepted",
    });
    await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: linkedLoop.id,
      artifactId: prArtifact.id,
      expectedPhase: "pr_linking",
      transitionEvent: "pr_linked",
      loopVersion: loopVersionForGateRun,
      now: new Date(),
    });
  }

  return true;
}

export async function checkpointThreadAndPush({
  threadId,
  threadChatId,
  userId,
  session,
  createPR,
  prType,
}: {
  threadId: string;
  threadChatId: string;
  userId: string;
  session: ISandboxSession;
  createPR: boolean;
  prType: "draft" | "ready";
}) {
  const thread = await getThread({ db, threadId, userId });
  if (!thread) {
    throw new ThreadError("unknown-error", "Thread not found", null);
  }
  const getGitDiffOrThrow = async (): Promise<{
    diffOutput: string | null;
    diffStats: GitDiffStats | null;
  }> => {
    try {
      const diffOutput = await getGitDiffMaybeCutoff({
        session,
        baseBranch: thread.repoBaseBranchName,
        allowCutoff: false,
      });
      const diffStats = await gitDiffStats(session, {
        baseBranch: thread.repoBaseBranchName,
      });
      return { diffOutput: sanitizeForJson(diffOutput), diffStats };
    } catch (error) {
      console.error("Failed to get git diff:", error);
      throw wrapError("git-checkpoint-diff-failed", error);
    }
  };

  // Git integrity checks are now always enabled

  try {
    let commitAndPushError: unknown = null;
    const updates: Partial<ThreadInsert> = {};
    const chatUpdates: Omit<ThreadChatInsert, "threadChatId"> = {};
    try {
      // Commit changes and push
      const { branchName, errorMessage } = await gitCommitAndPushBranch({
        session,
        args: {
          githubAppName: env.NEXT_PUBLIC_GITHUB_APP_NAME,
          baseBranch: thread.repoBaseBranchName,
          generateCommitMessage: generateCommitMessage,
        },
        enableIntegrityChecks: true,
      });
      if (errorMessage) {
        console.error("Failed at gitCommitAndPushBranch:", errorMessage);
        throw new ThreadError("git-checkpoint-push-failed", errorMessage, null);
      }
      if (branchName) {
        updates.branchName = branchName;
      }
    } catch (e) {
      // Keep this error for later, try to checkpoint a git diff anyway.
      commitAndPushError = wrapError("git-checkpoint-push-failed", e);
    }

    // Update git diff stats
    const { diffOutput, diffStats } = await getGitDiffOrThrow();
    updates.gitDiff = diffOutput;
    updates.gitDiffStats = diffStats;

    // Check if git diff has changed. We need to check the diff stats because
    // the diff output might be cutoff or simply "too-large".
    const diffOutputHasChanged =
      diffOutput === "too-large" ||
      diffOutput !== thread.gitDiff ||
      diffStats?.files !== thread.gitDiffStats?.files ||
      diffStats?.additions !== thread.gitDiffStats?.additions ||
      diffStats?.deletions !== thread.gitDiffStats?.deletions;
    if (diffOutput && diffOutputHasChanged) {
      // Create git diff checkpoint message
      const gitDiffMessage = createGitDiffCheckpoint({
        diff: diffOutput,
        diffStats,
      });
      chatUpdates.appendMessages = [gitDiffMessage];

      getPostHogServer().capture({
        distinctId: userId,
        event: "git_diff_changed",
        properties: {
          threadId,
          gitDiffSize: diffOutput.length,
          ...diffStats,
        },
      });
    }

    if (Object.keys(updates).length > 0) {
      await updateThread({
        db,
        userId,
        threadId,
        updates,
      });
    }
    if (Object.keys(chatUpdates).length > 0) {
      await updateThreadChat({
        db,
        userId,
        threadId,
        threadChatId,
        updates: chatUpdates,
      });
    }

    if (commitAndPushError) {
      // If the error is a git commit and push error, we can try to auto-fix it.
      // If we can't auto-fix it, we'll throw the error.
      if (
        await maybeAutoFixGitCommitAndPushError({
          userId,
          threadId,
          threadChatId,
          error: commitAndPushError,
        })
      ) {
        return;
      }
      throw commitAndPushError;
    }

    let handledBySdlcPipeline = false;
    try {
      handledBySdlcPipeline = await maybeRunStrictSdlcCheckpointPipeline({
        threadId,
        threadChatId,
        userId,
        session,
        createPR,
        prType,
        diffOutput,
      });
    } catch (sdlcError) {
      console.error(
        "SDLC checkpoint pipeline failed — falling through to normal checkpoint",
        {
          threadId,
          threadChatId,
          error:
            sdlcError instanceof Error
              ? { message: sdlcError.message, stack: sdlcError.stack }
              : sdlcError,
        },
      );
    }
    if (handledBySdlcPipeline) {
      return;
    }

    // Non-SDLC fallback path:
    // 1. Normal case: diffOutput exists and diff has changed
    // 2. After git retry: diffOutput exists but thread doesn't have a PR yet
    //    (handles the case where git push failed after diff was captured)
    if (
      diffOutput &&
      (diffOutputHasChanged || !thread.githubPRNumber) &&
      createPR
    ) {
      try {
        await openPullRequestForThread({
          userId,
          threadId,
          threadChatId,
          prType: prType,
          skipCommitAndPush: true,
          session,
        });
      } catch (e) {
        console.error("Failed to create PR:", e);
      }
    }
  } catch (e) {
    throw wrapError("git-checkpoint-push-failed", e);
  }
}

async function maybeAutoFixGitCommitAndPushError({
  userId,
  threadId,
  threadChatId,
  error,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  error: unknown;
}): Promise<boolean> {
  console.log("maybeAutoFixGitCommitAndPushError", {
    userId,
    threadId,
    threadChatId,
    error,
  });
  const threadChat = await getThreadChat({
    db,
    threadId,
    userId,
    threadChatId,
  });
  if (!threadChat || !threadChat.messages) {
    return false;
  }
  // Lets make sure that the most recent user/system message is not a retry message
  let lastSystemOrUserMessage: DBMessage | null = null;
  for (const message of [...threadChat.messages].reverse()) {
    if (message.type === "system" || message.type === "user") {
      lastSystemOrUserMessage = message;
      break;
    }
  }
  if (!lastSystemOrUserMessage) {
    console.error("No system or user message found", {
      userId,
      threadId,
      threadChatId,
    });
    return false;
  }
  if (
    lastSystemOrUserMessage.type === "system" &&
    lastSystemOrUserMessage.message_type === "retry-git-commit-and-push"
  ) {
    console.log("Last system or user message is a retry message, ignoring.");
    return false;
  }
  const systemRetryMessage: DBSystemMessage = {
    type: "system",
    message_type: "retry-git-commit-and-push",
    parts: [
      {
        type: "text",
        text: `Failed to commit and push changes with the following error: ${error}. Can you please try again?`,
      },
    ],
  };

  const thread = await getThreadMinimal({ db, userId, threadId });
  if (!thread) {
    return false;
  }
  // Make sure we keep the sandbox active. We're going to kick off a daemon
  // message to retry the commit and push.
  const sandboxId = thread.codesandboxId!;
  await setActiveThreadChat({ sandboxId, threadChatId, isActive: true });
  await sendSystemMessage({
    userId,
    threadId,
    threadChatId,
    message: systemRetryMessage,
  });
  return true;
}
