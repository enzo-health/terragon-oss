"use client";

import { useRef } from "react";
import {
  createCollection,
  localOnlyCollectionOptions,
  useLiveQuery,
  eq,
} from "@tanstack/react-db";
import { ThreadPageChat } from "@leo/shared/db/types";
import { BroadcastThreadPatch } from "@leo/types/broadcast";
import { validateChatPatch } from "./patch-helpers";

function chatKey(threadId: string, threadChatId: string): string {
  return `${threadId}:${threadChatId}`;
}

function buildCollection() {
  return createCollection(
    localOnlyCollectionOptions<ThreadPageChat>({
      getKey: (item) => chatKey(item.threadId, item.id),
    }),
  );
}

let _collection: ReturnType<typeof buildCollection> | null = null;

function getCollection() {
  if (!_collection) _collection = buildCollection();
  return _collection;
}

export { getCollection as getThreadChatCollection };

export function applyChatPatchToCollection(patch: BroadcastThreadPatch): {
  shouldInvalidate: boolean;
} {
  if (!patch.threadChatId) return { shouldInvalidate: false };
  const c = getCollection();
  if (c.status !== "ready") return { shouldInvalidate: false };
  const key = chatKey(patch.threadId, patch.threadChatId);
  const existing = c.state.get(key) as ThreadPageChat | undefined;
  if (!existing) return { shouldInvalidate: false };
  const result = validateChatPatch(existing, patch);
  if (result.action === "apply" && result.nextChat) {
    c.update(key, () => result.nextChat!);
    return { shouldInvalidate: false };
  }
  return { shouldInvalidate: result.action === "invalidate" };
}

export function seedChat(chat: ThreadPageChat): void {
  const c = getCollection();
  if (c.status !== "ready") return;
  const key = chatKey(chat.threadId, chat.id);
  if (c.state.has(key)) {
    c.update(key, () => chat);
  } else {
    c.insert(chat);
  }
}

/**
 * Reactive read from TanStack DB collection. Returns undefined if not yet seeded
 * or if threadChatId is not provided. Client-only (useLiveQuery needs useSyncExternalStore).
 */
export function useChatFromCollection(
  threadId: string,
  threadChatId: string | undefined,
): ThreadPageChat | undefined {
  const collectionRef = useRef(getCollection());
  const result = useLiveQuery(
    (q) =>
      q
        .from({ c: collectionRef.current })
        .where(({ c }) => eq(c.threadId, threadId))
        .where(({ c }) => eq(c.id, threadChatId ?? "")),
    [threadId, threadChatId],
  );
  if (!threadChatId) return undefined;
  return result.data?.[0] ?? undefined;
}
