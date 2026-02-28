"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { DBUserMessage } from "@terragon/shared";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { getThreadChat } from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import { DBMessage } from "@terragon/shared";
import {
  approvePlanArtifactForLoop,
  createPlanArtifactForLoop,
  getActiveSdlcLoopForThread,
  replacePlanTasksForArtifact,
  transitionSdlcLoopStateWithArtifact,
} from "@terragon/shared/model/sdlc-loop";
import * as z from "zod/v4";

const SDLC_PLAN_TOOL = {
  EXIT_PLAN_MODE: "ExitPlanMode",
  WRITE: "Write",
} as const;

const sdlcPlanTaskSchema = z.object({
  stableTaskId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  acceptance: z.array(z.string().trim().min(1)).optional(),
});

const sdlcPlanSpecSchema = z.object({
  planText: z.string().trim().min(1).optional(),
  tasks: z.array(sdlcPlanTaskSchema).min(1),
});

type ParsedPlanSpec = {
  planText: string;
  tasks: Array<{
    stableTaskId: string;
    title: string;
    description?: string | null;
    acceptance: string[];
  }>;
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
      message.name === SDLC_PLAN_TOOL.EXIT_PLAN_MODE &&
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
    if (message.type === "tool-call" && message.name === SDLC_PLAN_TOOL.WRITE) {
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

function extractLatestPlanText(messages: DBMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (
      message.type === "tool-call" &&
      message.name === SDLC_PLAN_TOOL.EXIT_PLAN_MODE &&
      typeof message.parameters?.plan === "string" &&
      message.parameters.plan.trim().length > 0
    ) {
      return message.parameters.plan.trim();
    }
    if (
      message.type === "tool-call" &&
      message.name === SDLC_PLAN_TOOL.EXIT_PLAN_MODE
    ) {
      const planFromWrite = findPlanFromWriteToolCall({
        messages,
        exitPlanModeToolId: message.id,
      });
      if (planFromWrite) {
        return planFromWrite.trim();
      }
    }
  }

  for (const message of [...messages].reverse()) {
    if (message.type !== "agent" || message.parent_tool_use_id !== null) {
      continue;
    }
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  return null;
}

function normalizeStableTaskId(value: string, index: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return `task-${index + 1}`;
  }
  return normalized;
}

function parsePlanSpec(planText: string): ParsedPlanSpec {
  const trimmed = planText.trim();
  const tryParseJson = (input: string): ParsedPlanSpec | null => {
    try {
      const parsed = JSON.parse(input) as {
        planText?: unknown;
        tasks?: unknown;
      };
      const normalized = sdlcPlanSpecSchema.safeParse(parsed);
      if (!normalized.success) {
        return null;
      }
      const tasks = normalized.data.tasks.map((task, index) => ({
        stableTaskId: task.stableTaskId
          ? task.stableTaskId.trim()
          : normalizeStableTaskId(task.title, index),
        title: task.title.trim(),
        description: task.description?.trim() ?? null,
        acceptance: task.acceptance ?? [],
      }));
      return {
        planText: normalized.data.planText?.trim() || trimmed,
        tasks,
      };
    } catch {
      return null;
    }
  };

  const directJson = tryParseJson(trimmed);
  if (directJson) {
    return directJson;
  }

  const fencedJsonMatches = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const match of fencedJsonMatches) {
    const candidate = tryParseJson(match[1] ?? "");
    if (candidate) {
      return candidate;
    }
  }

  const tasks = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:\d+[\.\)]|[-*]|(?:step|phase)\s+\d+[:.)-]?)\s+\S+/i.test(line),
    )
    .map((line, index) => {
      const title = line.replace(
        /^(?:\d+[\.\)]|[-*]|(?:step|phase)\s+\d+[:.)-]?)\s+/i,
        "",
      );
      return {
        stableTaskId: `task-${index + 1}`,
        title,
        description: null,
        acceptance: [],
      };
    });

  if (tasks.length === 0) {
    throw new UserFacingError(
      "Plan artifact is missing or invalid. Include at least one structured task before approval.",
    );
  }

  return {
    planText: trimmed,
    tasks,
  };
}

export const approvePlan = userOnlyAction(
  async function approvePlan(
    userId: string,
    {
      threadId,
      threadChatId,
    }: {
      threadId: string;
      threadChatId: string;
    },
  ) {
    console.log("approvePlan", { threadId, threadChatId });
    const threadChat = await getThreadChat({
      db,
      threadId,
      userId,
      threadChatId,
    });
    if (!threadChat) {
      throw new UserFacingError("Task not found");
    }
    const activeLoop = await getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    });
    if (!activeLoop) {
      throw new UserFacingError("No active SDLC loop found for this thread");
    }
    if (activeLoop.state !== "planning") {
      throw new UserFacingError(
        "Plan can only be approved while the SDLC loop is in planning phase",
      );
    }

    const latestPlanText = extractLatestPlanText(threadChat.messages ?? []);
    if (!latestPlanText) {
      throw new UserFacingError(
        "No plan artifact found. Generate a plan before approval.",
      );
    }

    const parsedPlan = parsePlanSpec(latestPlanText);
    const artifactStatus =
      activeLoop.planApprovalPolicy === "human_required"
        ? "generated"
        : "accepted";
    const nextLoopVersion =
      typeof activeLoop.loopVersion === "number" &&
      Number.isFinite(activeLoop.loopVersion)
        ? Math.max(activeLoop.loopVersion, 0) + 1
        : 1;
    const planArtifact = await createPlanArtifactForLoop({
      db,
      loopId: activeLoop.id,
      loopVersion: nextLoopVersion,
      status: artifactStatus,
      generatedBy: "agent",
      payload: {
        planText: parsedPlan.planText,
        tasks: parsedPlan.tasks,
        source: "system",
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: activeLoop.id,
      artifactId: planArtifact.id,
      tasks: parsedPlan.tasks,
    });

    let approvedArtifact = planArtifact;
    if (activeLoop.planApprovalPolicy === "human_required") {
      const maybeApproved = await approvePlanArtifactForLoop({
        db,
        loopId: activeLoop.id,
        artifactId: planArtifact.id,
        approvedByUserId: userId,
      });
      if (!maybeApproved) {
        throw new UserFacingError(
          "Failed to approve plan artifact for this SDLC loop",
        );
      }
      approvedArtifact = maybeApproved;
    }

    const transitionOutcome = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: activeLoop.id,
      artifactId: approvedArtifact.id,
      expectedPhase: "planning",
      transitionEvent: "plan_completed",
      loopVersion: nextLoopVersion,
    });
    if (transitionOutcome !== "updated") {
      throw new UserFacingError(
        "Plan approval gate failed. Refresh and try approving again.",
      );
    }

    const message: DBUserMessage = {
      type: "user",
      model: null,
      parts: [{ type: "text", text: "Please proceed with the plan" }],
      permissionMode: "allowAll",
    };
    await queueFollowUpInternal({
      userId,
      threadId,
      threadChatId,
      messages: [message],
      source: "www",
      appendOrReplace: "append",
    });
  },
  { defaultErrorMessage: "Failed to approve plan" },
);
