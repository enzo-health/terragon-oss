import { queueFollowUpInternal } from "@/server-lib/follow-up";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import type {
  ExternalTaskIntakeRequest,
  ExternalTaskIntakeResult,
} from "./types";
import {
  appendExternalTaskIntakeDedupeMarker,
  buildExternalTaskIntakeDedupeMarker,
} from "./idempotency";

export async function routeExternalTaskIntake(
  request: ExternalTaskIntakeRequest,
): Promise<ExternalTaskIntakeResult> {
  switch (request.intent) {
    case "create-thread": {
      const dedupeMarker = buildExternalTaskIntakeDedupeMarker({
        source: request.source,
        idempotencyKey: request.idempotencyKey,
      });
      const githubThreadIdentifiers =
        request.source === "github" || request.source === "automation"
          ? {
              githubPRNumber: request.githubPRNumber,
              githubIssueNumber: request.githubIssueNumber,
            }
          : {};
      const sourceMetadata =
        request.source === "github" ||
        request.source === "linear" ||
        request.source === "slack"
          ? { sourceMetadata: request.sourceMetadata }
          : {};
      const { threadId, threadChatId } = await newThreadInternal({
        userId: request.ownerUserId,
        message: appendExternalTaskIntakeDedupeMarker({
          message: request.message,
          marker: dedupeMarker,
        }),
        parentThreadId: undefined,
        parentToolId: undefined,
        ...((request.source === "github" || request.source === "automation") &&
        request.automation
          ? { automation: request.automation }
          : {}),
        ...(request.source === "automation" &&
        request.disableGitCheckpointing !== undefined
          ? { disableGitCheckpointing: request.disableGitCheckpointing }
          : {}),
        githubRepoFullName: request.githubRepoFullName,
        baseBranchName: request.baseBranchName,
        headBranchName: request.headBranchName,
        ...githubThreadIdentifiers,
        sourceType: request.sourceType,
        ...sourceMetadata,
      });

      return {
        intent: "create-thread",
        threadId,
        threadChatId,
      };
    }
    case "follow-up": {
      const dedupeMarker = buildExternalTaskIntakeDedupeMarker({
        source: request.source,
        idempotencyKey: request.idempotencyKey,
      });
      await queueFollowUpInternal({
        userId: request.ownerUserId,
        threadId: request.threadId,
        threadChatId: request.threadChatId,
        messages: [
          appendExternalTaskIntakeDedupeMarker({
            message: request.message,
            marker: dedupeMarker,
          }),
        ],
        appendOrReplace: request.appendOrReplace,
        source: request.source,
        ...(dedupeMarker ? { dedupeMarker } : {}),
      });

      return {
        intent: "follow-up",
        threadId: request.threadId,
        threadChatId: request.threadChatId,
      };
    }
  }
}
