import type {
  InputContent,
  Message as AgUiMessage,
  RunAgentInput,
} from "@ag-ui/core";
import type {
  DBUserMessage,
  DBRichTextPart,
  DBImagePart,
} from "@terragon/shared";
import { getThreadChat } from "@terragon/shared/model/threads";
import { getLatestRunIdForThreadChat } from "@terragon/shared/model/agent-event-log";
import { db } from "@/lib/db";
import { redis } from "@/lib/redis";
import { followUpInternal } from "@/server-lib/follow-up";
import { decodeTerragonAgUiRunConfig } from "@/lib/terragon-ag-ui-run-config";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type AgUiRunResult =
  | { runId: string }
  | { skipped: "replay-mode" }
  | { skipped: "duplicate-submission" }
  | { error: AgUiRunError };

export type AgUiRunError =
  | { kind: "unauthorized" }
  | { kind: "thread-not-found" }
  | { kind: "lock-held" } // another POST already in flight
  | { kind: "invalid-input"; reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_TTL_SECONDS = 5;
const SUBMISSION_DEDUPE_TTL_SECONDS = 60 * 60 * 24;

function runLockKey(threadChatId: string): string {
  return `lock:run:${threadChatId}`;
}

function submissionDedupeKey(
  threadChatId: string,
  clientSubmissionId: string,
): string {
  return `dedupe:ag-ui-submission:${threadChatId}:${clientSubmissionId}`;
}

// ---------------------------------------------------------------------------
// AG-UI → DBUserMessage part conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single AG-UI InputContent item to a DBUserMessage part.
 * Returns null for content types that have no DB equivalent.
 */
function inputContentToDbPart(
  content: InputContent,
): DBImagePart | DBRichTextPart | null {
  if (content.type === "text") {
    return {
      type: "rich-text",
      nodes: [{ type: "text", text: content.text }],
    } satisfies DBRichTextPart;
  }

  if (content.type === "image") {
    const source = content.source;
    if (source.type === "url") {
      return {
        type: "image",
        image_url: source.value,
        mime_type: source.mimeType ?? "image/jpeg",
      } satisfies DBImagePart;
    }
    if (source.type === "data") {
      // data-URL encoded: embed as a base64 data URL for the image part
      const dataUrl = `data:${source.mimeType};base64,${source.value}`;
      return {
        type: "image",
        image_url: dataUrl,
        mime_type: source.mimeType,
      } satisfies DBImagePart;
    }
    return null;
  }

  // binary, audio, video, document — no DB equivalent yet
  return null;
}

/**
 * Convert an AG-UI user message's content to DBUserMessage parts.
 *
 * AG-UI user messages carry content as either a plain string or an array of
 * InputContent items. This is the inverse of buildUserContent() in
 * terragon-ag-ui-conversions.ts.
 */
function agUiUserContentToDbParts(
  content: AgUiUserMessage["content"],
): DBUserMessage["parts"] {
  if (typeof content === "string") {
    if (content.length === 0) {
      return [];
    }
    return [
      {
        type: "rich-text",
        nodes: [{ type: "text", text: content }],
      },
    ];
  }

  const parts: DBUserMessage["parts"] = [];
  for (const item of content) {
    const part = inputContentToDbPart(item);
    if (part !== null) {
      parts.push(part);
    }
  }
  return parts;
}

function validateAgUiUserContent(
  content: AgUiUserMessage["content"],
): string | null {
  if (typeof content === "string") {
    return null;
  }
  for (const item of content) {
    if (item.type === "image" && item.source.type === "url") {
      return "AG-UI URL image sources are not accepted; upload the image first";
    }
  }
  return null;
}

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
      "[run-from-ag-ui] ignoring unsupported state fields: saveAsDraft/scheduleAt",
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
export async function runFollowUpFromAgUiInput(args: {
  threadId: string;
  threadChatId: string;
  userId: string;
  body: RunAgentInput;
  /**
   * Set when the request comes from the integration harness in replay mode.
   * Skips followUp invocation — no DB writes, no lock, no dispatch.
   */
  isReplayMode: boolean;
}): Promise<AgUiRunResult> {
  const { threadId, threadChatId, userId, body, isReplayMode } = args;

  // 1. Replay-mode bypass
  if (isReplayMode) {
    return { skipped: "replay-mode" };
  }

  // 2. Validate ownership
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
  } = decodeTerragonAgUiRunConfig(body.forwardedProps);
  if (invalidSelectedModel !== null) {
    return {
      error: {
        kind: "invalid-input",
        reason: `Invalid selectedModel: ${invalidSelectedModel}`,
      },
    };
  }
  const submissionKey =
    clientSubmissionId !== null
      ? submissionDedupeKey(threadChatId, clientSubmissionId)
      : null;
  if (submissionKey !== null) {
    const claimedSubmission = await redis.set(submissionKey, "1", {
      nx: true,
      ex: SUBMISSION_DEDUPE_TTL_SECONDS,
    });
    if (claimedSubmission === null) {
      return { skipped: "duplicate-submission" };
    }
  }

  let dispatchedFollowUp = false;

  // 3. Acquire advisory lock (SET NX EX) to prevent double-dispatch on retry
  const lockKey = runLockKey(threadChatId);
  const acquired = await redis.set(lockKey, "1", {
    nx: true,
    ex: LOCK_TTL_SECONDS,
  });

  if (acquired === null) {
    if (submissionKey !== null) {
      await redis.del(submissionKey);
    }
    // Lock already held by another concurrent POST
    return { error: { kind: "lock-held" } };
  }

  try {
    // 4. Extract the new user message
    const agUiUserMessage = extractUserMessage(body);
    if (agUiUserMessage === null) {
      return {
        error: {
          kind: "invalid-input",
          reason: "No user message found in body.messages",
        },
      };
    }
    const contentValidationError = validateAgUiUserContent(
      agUiUserMessage.content,
    );
    if (contentValidationError !== null) {
      return {
        error: {
          kind: "invalid-input",
          reason: contentValidationError,
        },
      };
    }

    // 5. Map AG-UI message → DBUserMessage
    const parts = agUiUserContentToDbParts(agUiUserMessage.content);
    if (parts.length === 0) {
      return {
        error: {
          kind: "invalid-input",
          reason: "User message content is empty",
        },
      };
    }

    // 6. Extract metadata
    extractStateMetadata(body); // logs TODO for unsupported fields

    const message: DBUserMessage = {
      type: "user",
      model: selectedModel,
      parts,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
    };

    // 7. Call followUpInternal
    await followUpInternal({
      userId,
      threadId,
      threadChatId,
      message,
      source: "www",
    });
    dispatchedFollowUp = true;

    // 8. Return runId from DB.
    //
    // followUp dispatches via waitUntil() (non-blocking), so the run row may
    // not be written yet. We do a best-effort lookup and return whatever is
    // current. Callers should treat a null runId as "run dispatched, id not
    // yet available" and poll the SSE stream for RUN_STARTED.
    const runId = await getLatestRunIdForThreadChat({ db, threadChatId });
    return { runId: runId ?? "" };
  } finally {
    if (!dispatchedFollowUp && submissionKey !== null) {
      await redis.del(submissionKey);
    }
    // Always release the lock, even on error
    await redis.del(lockKey);
  }
}
