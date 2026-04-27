"use client";

import { useRef } from "react";
import {
  createCollection,
  localOnlyCollectionOptions,
  useLiveQuery,
  eq,
} from "@tanstack/react-db";
import { ThreadPageChat } from "@terragon/shared/db/types";
import { BroadcastThreadPatch } from "@terragon/types/broadcast";
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

type ChatCollection = ReturnType<typeof buildCollection>;
type PendingCollectionWrite = (collection: ChatCollection) => void;

let _collection: ChatCollection | null = null;
let _pendingWrites: PendingCollectionWrite[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingWrites(collection: ChatCollection) {
  if (collection.status !== "ready" || _pendingWrites.length === 0) {
    return;
  }
  const pendingWrites = _pendingWrites;
  _pendingWrites = [];
  pendingWrites.forEach((write) => write(collection));
}

function schedulePendingWriteFlush() {
  if (_flushTimer) {
    return;
  }
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    const collection = getCollection();
    if (collection.status === "ready") {
      flushPendingWrites(collection);
      return;
    }
    if (_pendingWrites.length > 0) {
      schedulePendingWriteFlush();
    }
  }, 16);
}

function getCollection() {
  if (!_collection) _collection = buildCollection();
  flushPendingWrites(_collection);
  return _collection;
}

export { getCollection as getThreadChatCollection };

export function applyChatPatchToCollection(patch: BroadcastThreadPatch): {
  shouldInvalidate: boolean;
} {
  if (!patch.threadChatId) return { shouldInvalidate: false };
  const c = getCollection();
  if (c.status !== "ready") return { shouldInvalidate: true };
  const key = chatKey(patch.threadId, patch.threadChatId);
  const existing = c.state.get(key) as ThreadPageChat | undefined;
  if (!existing) return { shouldInvalidate: false };
  const result = validateChatPatch(existing, patch);
  if (result.action === "apply" && result.nextChat) {
    const nextChat = result.nextChat;
    c.update(key, (draft) => {
      Object.assign(draft, nextChat);
    });
    return { shouldInvalidate: false };
  }
  return { shouldInvalidate: result.action === "invalidate" };
}

export function seedChat(chat: ThreadPageChat): void {
  const key = chatKey(chat.threadId, chat.id);
  const write: PendingCollectionWrite = (c) => {
    const existing = c.state.get(key) as ThreadPageChat | undefined;
    if (existing) {
      if (!isIncomingChatSeedFresh(existing, chat)) {
        return;
      }
      c.update(key, (draft) => {
        Object.assign(draft, chat);
      });
    } else {
      c.insert(chat);
    }
  };

  const c = getCollection();
  if (c.status !== "ready") {
    _pendingWrites.push(write);
    schedulePendingWriteFlush();
    return;
  }
  write(c);
}

function isIncomingChatSeedFresh(
  existing: ThreadPageChat,
  incoming: ThreadPageChat,
): boolean {
  const existingMessageSeq = existing.messageSeq ?? null;
  const incomingMessageSeq = incoming.messageSeq ?? null;
  if (existingMessageSeq !== null && incomingMessageSeq !== null) {
    if (incomingMessageSeq !== existingMessageSeq) {
      return incomingMessageSeq > existingMessageSeq;
    }
  }

  const existingPatchVersion = existing.patchVersion ?? null;
  const incomingPatchVersion = incoming.patchVersion ?? null;
  if (existingPatchVersion !== null && incomingPatchVersion !== null) {
    return incomingPatchVersion >= existingPatchVersion;
  }

  return getTime(incoming.updatedAt) >= getTime(existing.updatedAt);
}

function getTime(value: Date | string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

export function updateChatInCollection({
  threadId,
  threadChatId,
  updater,
}: {
  threadId: string;
  threadChatId: string;
  updater: (currentChat: ThreadPageChat) => ThreadPageChat;
}): void {
  const key = chatKey(threadId, threadChatId);
  const write: PendingCollectionWrite = (c) => {
    const existing = c.state.get(key) as ThreadPageChat | undefined;
    if (!existing) {
      return;
    }
    const nextChat = updater(existing);
    c.update(key, (draft) => {
      Object.assign(draft, nextChat);
    });
  };

  const c = getCollection();
  if (c.status !== "ready") {
    _pendingWrites.push(write);
    schedulePendingWriteFlush();
    return;
  }
  write(c);
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
