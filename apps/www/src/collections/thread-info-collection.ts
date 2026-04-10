"use client";

import {
  createCollection,
  localOnlyCollectionOptions,
} from "@tanstack/react-db";
import { ThreadInfo } from "@leo/shared/db/types";
import { BroadcastThreadPatch } from "@leo/types/broadcast";
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

export function getThreadInfoCollection() {
  if (!_collection) _collection = buildCollection();
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
      "[thread-info-collection] collection not ready, writes are being dropped",
    );
    _warnedNotReady = true;
  }
  return false;
}

export function seedThreadList(threads: ThreadInfo[]): void {
  const collection = getThreadInfoCollection();
  if (!guardReady(collection)) return;
  for (const thread of threads) {
    if (collection.state.has(thread.id)) {
      collection.update(thread.id, () => thread);
    } else {
      collection.insert(thread);
    }
  }
}

export function applyThreadPatchToCollection(
  patch: BroadcastThreadPatch,
): void {
  const collection = getThreadInfoCollection();
  if (!guardReady(collection)) return;
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
    if (updated !== existing) collection.update(patch.threadId, () => updated);
  } else if (patch.shell?.userId) {
    const newThread = threadPatchToListThread(patch);
    if (newThread) collection.insert(newThread);
  }
}
