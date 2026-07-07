import { randomUUID } from "node:crypto";
import type { DB } from "@terragon/shared/db";
import type { DBUserMessageWithModel } from "@terragon/shared";
import { upsertAgentRunContext } from "@terragon/shared/model/agent-run-context";
import { getThreadChat, updateThread } from "@terragon/shared/model/threads";
import { createDaemonRunCredentials } from "@/agent/helpers/create-daemon-run";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import { persistSideEffectAgUiMessages } from "@/server-lib/ag-ui-side-effect-messages";
import {
  EMULATOR_AGENT,
  EMULATOR_PROTOCOL_VERSION,
  EMULATOR_TRANSPORT_MODE,
} from "./daemon-batches";
import { resolveEmulatorScenario } from "./scenarios";
import { runEmulatorStream } from "./run-emulator";

const EMULATOR_TIMEZONE = "UTC";

function emulatorSandboxId(threadChatId: string): string {
  return `emulator-${threadChatId}`;
}

function extractPromptText(
  message: DBUserMessageWithModel | null | undefined,
): string {
  if (!message) {
    return "";
  }
  return message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export type RunEmulatedAgentMessageParams = {
  db: DB;
  userId: string;
  message?: DBUserMessageWithModel | null;
  threadId: string;
  threadChatId: string;
  isNewThread: boolean;
};

export async function runEmulatedAgentMessage(
  params: RunEmulatedAgentMessageParams,
): Promise<{ dispatchLaunched: boolean }> {
  const { db, userId, message, threadId, threadChatId, isNewThread } = params;
  const threadChat = await getThreadChat({
    db,
    threadId,
    threadChatId,
    userId,
  });
  if (!threadChat) {
    throw new Error(
      `[agent-emulator] thread chat not found for ${threadChatId}`,
    );
  }

  const { scenario, prompt } = resolveEmulatorScenario(
    extractPromptText(message),
  );
  const runId = randomUUID();
  const tokenNonce = randomUUID();
  const sandboxId = emulatorSandboxId(threadChatId);
  const permissionMode = threadChat.permissionMode ?? "allowAll";

  await updateThread({
    db,
    userId,
    threadId,
    updates: { disableGitCheckpointing: true },
  });

  const bootTransition = await updateThreadChatWithTransition({
    db,
    userId,
    threadId,
    threadChatId,
    eventType: "system.boot",
    chatUpdates: {
      errorMessage: null,
      errorMessageInfo: null,
      appendMessages: !isNewThread && message ? [message] : undefined,
    },
  });

  await upsertAgentRunContext({
    db,
    runId,
    userId,
    threadId,
    threadChatId,
    sandboxId,
    transportMode: EMULATOR_TRANSPORT_MODE,
    protocolVersion: EMULATOR_PROTOCOL_VERSION,
    agent: EMULATOR_AGENT,
    permissionMode,
    requestedSessionId: null,
    resolvedSessionId: null,
    runtimeProvider: "claude-acp",
    externalSessionId: null,
    previousResponseId: null,
    status: "pending",
    tokenNonce,
  });

  if (message) {
    await persistSideEffectAgUiMessages({
      db,
      threadId,
      threadChatId,
      messages: [message],
      source: isNewThread ? "initial-user-prompt" : "follow-up-user-prompt",
      chatSequence: bootTransition.chatSequence,
      runId,
    });
  }

  const { token } = await createDaemonRunCredentials({
    userId,
    threadId,
    threadChatId,
    sandboxId,
    runId,
    tokenNonce,
    agent: EMULATOR_AGENT,
    transportMode: EMULATOR_TRANSPORT_MODE,
    protocolVersion: EMULATOR_PROTOCOL_VERSION,
  });

  void runEmulatorStream({
    userId,
    threadId,
    threadChatId,
    runId,
    token,
    prompt,
    scenario,
    timezone: EMULATOR_TIMEZONE,
  });

  return { dispatchLaunched: true };
}
