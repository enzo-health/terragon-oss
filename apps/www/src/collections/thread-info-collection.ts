"use client";

import {
  createCollection,
  localOnlyCollectionOptions,
} from "@tanstack/react-db";
import { ThreadInfo } from "@terragon/shared/db/types";
import { BroadcastThreadPatch } from "@terragon/types/broadcast";
import {
  applyThreadPatchToListThread,
  threadPatchToListThread,
} from "@/queries/thread-patch-cache";

function buildCollection() {
  return createCollection(
    localOnlyCollectionOptions<ThreadInfo>({
      getKey: (item) => item.id,
    }),
  );
}

// Lazy singleton — created on first access, not at module import time.
let _collection: ReturnType<typeof buildCollection> | null = null;
type PendingCollectionWrite = (
  collection: ReturnType<typeof buildCollection>,
) => void;
let _pendingWrites: PendingCollectionWrite[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingWrites(collection: ReturnType<typeof buildCollection>) {
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
    const collection = getThreadInfoCollection();
    if (collection.status === "ready") {
      flushPendingWrites(collection);
      return;
    }
    if (_pendingWrites.length > 0) {
      schedulePendingWriteFlush();
    }
  }, 16);
}

export function getThreadInfoCollection() {
  if (!_collection) _collection = buildCollection();
  flushPendingWrites(_collection);
  return _collection;
}

/**
 * Seed the collection with initial data from React Query (e.g., after SSR hydration).
 * Called from useThreadInfoList when the initial fetch completes.
 */
let _warnedNotReady = false;
function guardReady(
  collection: ReturnType<typeof getThreadInfoCollection>,
): boolean {
  if (collection.status === "ready") return true;
  if (!_warnedNotReady) {
    console.warn(
      "[thread-info-collection] collection not ready, writes are being queued",
    );
    _warnedNotReady = true;
  }
  return false;
}

function applyCollectionWrite(write: PendingCollectionWrite): void {
  const collection = getThreadInfoCollection();
  if (!guardReady(collection)) {
    _pendingWrites.push(write);
    schedulePendingWriteFlush();
    return;
  }
  write(collection);
}

export function seedThreadList(threads: ThreadInfo[]): void {
  applyCollectionWrite((collection) => {
    for (const thread of threads) {
      if (collection.state.has(thread.id)) {
        collection.update(thread.id, () => thread);
      } else {
        collection.insert(thread);
      }
    }
  });
}

export function insertThreadInfo(thread: ThreadInfo): void {
  applyCollectionWrite((collection) => {
    if (collection.state.has(thread.id)) {
      collection.update(thread.id, () => thread);
      return;
    }
    collection.insert(thread);
  });
}

export function removeThreadInfo(threadId: string): void {
  applyCollectionWrite((collection) => {
    if (collection.state.has(threadId)) {
      collection.delete(threadId);
    }
  });
}

export function replaceThreadInfo({
  existingId,
  nextThread,
}: {
  existingId: string;
  nextThread: ThreadInfo;
}): void {
  applyCollectionWrite((collection) => {
    const existing = collection.state.get(existingId) as ThreadInfo | undefined;
    const mergedThread = existing
      ? {
          ...existing,
          ...nextThread,
          id: nextThread.id,
          threadChats: nextThread.threadChats,
        }
      : nextThread;

    if (collection.state.has(nextThread.id)) {
      collection.update(nextThread.id, () => mergedThread);
    } else {
      collection.insert(mergedThread);
    }

    if (existingId !== nextThread.id && collection.state.has(existingId)) {
      collection.delete(existingId);
    }
  });
}

export function applyThreadPatchToCollection(
  patch: BroadcastThreadPatch,
): void {
  applyCollectionWrite((collection) => {
    if (patch.op === "delete") {
      if (collection.state.has(patch.threadId)) {
        collection.delete(patch.threadId);
      }
      return;
    }
    const existing = collection.state.get(patch.threadId) as
      | ThreadInfo
      | undefined;
    if (existing) {
      const updated = applyThreadPatchToListThread(existing, patch);
      if (updated !== existing) {
        collection.update(patch.threadId, () => updated);
      }
    } else if (patch.shell?.userId) {
      const newThread = threadPatchToListThread(patch);
      if (newThread) collection.insert(newThread);
    }
  });
}
