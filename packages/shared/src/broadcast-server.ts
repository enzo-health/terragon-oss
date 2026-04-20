import {
  BroadcastChannelUser,
  BroadcastUserMessage,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import { env } from "@terragon/env/pkg-shared";
import { publicBroadcastUrl } from "@terragon/env/next-public";

export type PatchVersionProviderFn = (threadChatId: string) => Promise<number>;

let patchVersionProviderFn: PatchVersionProviderFn | undefined;

/**
 * Register a callback to get the next patch version for a thread chat.
 * Uses Redis INCR for monotonic, ephemeral versioning.
 * Called by apps/www at startup.
 */
export function registerPatchVersionProvider(fn: PatchVersionProviderFn): void {
  patchVersionProviderFn = fn;
}

/**
 * Get the next patch version for a thread chat.
 * Returns 0 if no provider is registered (e.g., in tests).
 */
export async function getNextPatchVersion(
  threadChatId: string,
): Promise<number> {
  if (!patchVersionProviderFn) return 0;
  try {
    return await patchVersionProviderFn(threadChatId);
  } catch (error) {
    console.warn("Failed to get patch version", { threadChatId, error });
    return 0;
  }
}

function getBroadcastPublishUrl(rawUrl: string): string {
  const normalizedUrl = new URL(rawUrl);
  if (normalizedUrl.protocol === "ws:") {
    normalizedUrl.protocol = "http:";
  } else if (normalizedUrl.protocol === "wss:") {
    normalizedUrl.protocol = "https:";
  }
  return normalizedUrl.toString().replace(/\/$/, "");
}

/**
 * Publish a delta broadcast for token-level streaming.
 * Deltas are already persisted and sequenced before publish in API routes.
 * This function only emits the realtime patch.
 */
export async function publishDeltaBroadcast({
  userId,
  threadId,
  threadChatId,
  messageId,
  partIndex,
  deltaSeq,
  deltaIdempotencyKey,
  deltaKind,
  text,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
  messageId: string;
  partIndex: number;
  deltaSeq?: number;
  deltaIdempotencyKey?: string;
  deltaKind?: "text" | "thinking";
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
          ...(deltaSeq !== undefined ? { deltaSeq } : {}),
          ...(deltaIdempotencyKey ? { deltaIdempotencyKey } : {}),
          ...(deltaKind ? { deltaKind } : {}),
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
  const broadcastPublishUrl = getBroadcastPublishUrl(partySocketUrl);
  const channel: BroadcastChannelUser = {
    type: "user",
    id: message.id,
  };
  try {
    await fetch(
      `${broadcastPublishUrl}/parties/main/${getBroadcastChannelStr(channel)}`,
      {
        method: "POST",
        body: JSON.stringify(message),
        headers: {
          "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET!,
        },
      },
    );
  } catch (error) {
    console.warn("Broadcast publish failed", {
      channel,
      error,
    });
  }
}
