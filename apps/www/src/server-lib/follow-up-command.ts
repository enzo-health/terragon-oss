import type { Message as AgUiMessage, RunAgentInput } from "@ag-ui/core";
import type { DBUserMessage } from "@terragon/shared";
import { getThreadChat } from "@terragon/shared/model/threads";
import { getLatestRunIdForThreadChat } from "@terragon/shared/model/agent-event-log";
import { db } from "@/lib/db";
import { followUpInternal } from "@/server-lib/follow-up";
import { decodeRunMetadata } from "@/lib/run-metadata";
import { agUiUserContentToDbParts } from "@/lib/user-message-content";
import { withFollowUpSubmissionGuard } from "@/server-lib/ag-ui/follow-up-submission-guard";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type FollowUpCommandResult =
  | { runId: string }
  | { skipped: "duplicate-submission" }
  | { error: FollowUpCommandError };

export type FollowUpCommandError =
  | { kind: "unauthorized" }
  | { kind: "lock-held" } // another POST already in flight
  | { kind: "invalid-input"; reason: string };

// Narrowed type — only user-role messages
type AgUiUserMessage = Extract<AgUiMessage, { role: "user" }>;

function isUserMessage(msg: AgUiMessage): msg is AgUiUserMessage {
  return msg.role === "user";
}

/**
 * Extract the user message to dispatch from the AG-UI body.
 *
 * Per spec: take the last user message in body.messages.
 */
function extractUserMessage(body: RunAgentInput): AgUiUserMessage | null {
  const userMessages = body.messages.filter(isUserMessage);
  return userMessages[userMessages.length - 1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractStateMetadata(body: RunAgentInput): void {
  // TODO: handle body.state?.terragon?.saveAsDraft and body.state?.terragon?.scheduleAt
  // These were never wired into followUp() and are out of scope for this first cut.
  const state = body.state;
  if (!isRecord(state)) return;
  const terragon = state["terragon"];
  if (!isRecord(terragon)) return;
  if ("saveAsDraft" in terragon || "scheduleAt" in terragon) {
    console.log(
      "[follow-up-command] ignoring unsupported state fields: saveAsDraft/scheduleAt",
      {
        saveAsDraft: terragon["saveAsDraft"],
        scheduleAt: terragon["scheduleAt"],
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Main adapter
// ---------------------------------------------------------------------------

/**
 * Adapt an AG-UI RunAgentInput into a followUpInternal() call.
 *
 * See contract in spec comment at top of file.
 */
export async function dispatchFollowUpFromAppend(args: {
  threadId: string;
  threadChatId: string;
  userId: string;
  body: RunAgentInput;
}): Promise<FollowUpCommandResult> {
  const { threadId, threadChatId, userId, body } = args;

  // 1. Validate ownership
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });

  if (!threadChat) {
    // getThreadChat filters by userId; a miss means either not found or unauthorized.
    // We can't distinguish them without a secondary lookup, so return unauthorized
    // (the less-informative but safer response).
    return { error: { kind: "unauthorized" } };
  }

  const {
    selectedModel,
    invalidSelectedModel,
    permissionMode,
    clientSubmissionId,
  } = decodeRunMetadata(body.forwardedProps);
  if (invalidSelectedModel !== null) {
    return {
      error: {
        kind: "invalid-input",
        reason: `Invalid selectedModel: ${invalidSelectedModel}`,
      },
    };
  }

  // 2. Extract the new user message
  const agUiUserMessage = extractUserMessage(body);
  if (agUiUserMessage === null) {
    return {
      error: {
        kind: "invalid-input",
        reason: "No user message found in body.messages",
      },
    };
  }
  const partsResult = agUiUserContentToDbParts(agUiUserMessage.content);
  if (partsResult.type === "unsupported") {
    return {
      error: {
        kind: "invalid-input",
        reason: partsResult.reason,
      },
    };
  }

  // 4. Map AG-UI message → DBUserMessage
  const { parts } = partsResult;
  if (parts.length === 0) {
    return {
      error: {
        kind: "invalid-input",
        reason: "User message content is empty",
      },
    };
  }

  // 5. Extract metadata
  extractStateMetadata(body); // logs TODO for unsupported fields

  const message: DBUserMessage = {
    type: "user",
    model: selectedModel,
    parts,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };

  // 6. Guard and dispatch
  const guarded = await withFollowUpSubmissionGuard({
    threadChatId,
    clientSubmissionId,
    dispatch: async (markDispatched) => {
      await followUpInternal({
        userId,
        threadId,
        threadChatId,
        message,
        source: "www",
      });
      markDispatched();

      // 7. Return runId from DB.
      //
      // followUp dispatches via waitUntil() (non-blocking), so the run row may
      // not be written yet. We do a best-effort lookup and return whatever is
      // current. Callers should treat a null runId as "run dispatched, id not
      // yet available" and poll the SSE stream for RUN_STARTED.
      const runId = await getLatestRunIdForThreadChat({ db, threadChatId });
      return { runId: runId ?? "" };
    },
  });

  if (guarded.type === "duplicate-submission") {
    return { skipped: "duplicate-submission" };
  }
  if (guarded.type === "lock-held") {
    return { error: { kind: "lock-held" } };
  }

  return guarded.value;
}
