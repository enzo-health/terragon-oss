import {
  BroadcastChannelUser,
  BroadcastUserMessage,
  BroadcastThreadPatch,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import { env } from "@terragon/env/pkg-shared";
import { publicBroadcastUrl } from "@terragon/env/next-public";

export type MessageStreamAppendFn = (
  threadId: string,
  seq: number,
  messages: unknown[],
) => Promise<void>;

let messageStreamAppendFn: MessageStreamAppendFn | undefined;

/**
 * Register a callback to append messages to a Redis stream
 * alongside broadcast publishes. Called by apps/www at startup.
 */
export function registerMessageStreamAppend(fn: MessageStreamAppendFn): void {
  messageStreamAppendFn = fn;
}

async function appendToStreamIfRegistered(
  patches: BroadcastThreadPatch[] | undefined,
): Promise<void> {
  if (!messageStreamAppendFn || !patches) return;
  for (const patch of patches) {
    if (
      patch.chatSequence !== undefined &&
      patch.appendMessages &&
      patch.appendMessages.length > 0
    ) {
      try {
        await messageStreamAppendFn(
          patch.threadId,
          patch.chatSequence,
          patch.appendMessages,
        );
      } catch (error) {
        console.warn("Message stream append failed", {
          threadId: patch.threadId,
          error,
        });
      }
    }
  }
}

/**
 * Publish a delta broadcast for token-level streaming.
 * Deltas are ephemeral — NOT persisted to DB, NOT added to Redis Stream,
 * NOT replayed on reconnect.
 */
export async function publishDeltaBroadcast({
  userId,
  threadId,
  threadChatId,
  messageId,
  partIndex,
  text,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  messageId: string;
  partIndex: number;
  text: string;
}): Promise<void> {
  return publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      threadPatches: [
        {
          threadId,
          threadChatId,
          op: "delta",
          messageId,
          partIndex,
          text,
        },
      ],
    },
  });
}

export async function publishBroadcastUserMessage(
  message: BroadcastUserMessage,
) {
  // Skip publishing broadcast messages in tests
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const partySocketUrl = publicBroadcastUrl();
  if (!partySocketUrl) {
    console.warn("Party socket URL not set");
    return;
  }
  const channel: BroadcastChannelUser = {
    type: "user",
    id: message.id,
  };
  try {
    await Promise.all([
      fetch(
        `${partySocketUrl}/parties/main/${getBroadcastChannelStr(channel)}`,
        {
          method: "POST",
          body: JSON.stringify(message),
          headers: {
            "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET!,
          },
        },
      ),
      appendToStreamIfRegistered(message.data.threadPatches),
    ]);
  } catch (error) {
    console.warn("Broadcast publish failed", {
      channel,
      error,
    });
  }
}
