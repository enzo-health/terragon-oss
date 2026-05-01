"use client";

import {
  createCollection,
  localOnlyCollectionOptions,
} from "@tanstack/react-db";
import type {
  AgUiHistoryItem,
  AgUiHistoryMessagesResult,
} from "@/lib/ag-ui-history-types";

export type ThreadTranscriptEntry = {
  /** Composite key: `${threadId}:${threadChatId}` */
  id: string;
  threadId: string;
  threadChatId: string;
  messages: AgUiHistoryItem[];
  lastSeq: number;
  /** Wall-clock ms when this snapshot was cached. */
  cachedAt: number;
};

function transcriptKey(threadId: string, threadChatId: string): string {
  return `${threadId}:${threadChatId}`;
}

function buildCollection() {
  return createCollection(
    localOnlyCollectionOptions<ThreadTranscriptEntry>({
      getKey: (item) => item.id,
    }),
  );
}

type TranscriptCollection = ReturnType<typeof buildCollection>;
type PendingCollectionWrite = (collection: TranscriptCollection) => void;

let _collection: TranscriptCollection | null = null;
let _pendingWrites: PendingCollectionWrite[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushPendingWrites(collection: TranscriptCollection) {
  if (collection.status !== "ready" || _pendingWrites.length === 0) {
    return;
  }
  const pendingWrites = _pendingWrites;
  _pendingWrites = [];
  pendingWrites.forEach((write) => write(collection));
}

function schedulePendingWriteFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    const collection = getThreadTranscriptCollection();
    if (collection.status === "ready") {
      flushPendingWrites(collection);
      return;
    }
    if (_pendingWrites.length > 0) {
      schedulePendingWriteFlush();
    }
  }, 16);
}

export function getThreadTranscriptCollection(): TranscriptCollection {
  if (!_collection) _collection = buildCollection();
  flushPendingWrites(_collection);
  return _collection;
}

function applyCollectionWrite(write: PendingCollectionWrite): void {
  const collection = getThreadTranscriptCollection();
  if (collection.status !== "ready") {
    _pendingWrites.push(write);
    schedulePendingWriteFlush();
    return;
  }
  write(collection);
}

/**
 * Cache a transcript snapshot. Newer (higher `lastSeq`) writes always win;
 * equal-seq writes refresh the `cachedAt` timestamp; lower-seq writes are
 * dropped so an in-flight stale fetch never overwrites a fresher one.
 */
export function seedTranscript({
  threadId,
  threadChatId,
  result,
}: {
  threadId: string;
  threadChatId: string;
  result: AgUiHistoryMessagesResult;
}): void {
  const id = transcriptKey(threadId, threadChatId);
  const entry: ThreadTranscriptEntry = {
    id,
    threadId,
    threadChatId,
    messages: result.messages,
    lastSeq: result.lastSeq,
    cachedAt: Date.now(),
  };
  applyCollectionWrite((collection) => {
    const existing = collection.state.get(id) as
      | ThreadTranscriptEntry
      | undefined;
    if (existing) {
      if (entry.lastSeq < existing.lastSeq) return;
      collection.update(id, (draft) => {
        Object.assign(draft, entry);
      });
      return;
    }
    collection.insert(entry);
  });
}

/**
 * Synchronous read for use in render-once callbacks (e.g., loadHistoryMessages).
 * Returns undefined if the collection is not ready, has no entry, or the
 * stored entry is malformed (defensive guard against storage corruption).
 */
export function getCachedTranscript(
  threadId: string,
  threadChatId: string,
): AgUiHistoryMessagesResult | undefined {
  const collection = getThreadTranscriptCollection();
  if (collection.status !== "ready") return undefined;
  const raw = collection.state.get(transcriptKey(threadId, threadChatId));
  if (!raw) return undefined;
  // Defensive shape check — collection.state values should always be
  // ThreadTranscriptEntry but guard against storage-level corruption.
  const asRecord = raw as unknown as Record<string, unknown>;
  if (
    !Array.isArray(asRecord.messages) ||
    typeof asRecord.lastSeq !== "number"
  ) {
    return undefined;
  }
  const entry = raw as unknown as ThreadTranscriptEntry;
  return { messages: entry.messages, lastSeq: entry.lastSeq };
}

/**
 * Drop a cached transcript (e.g., after an error or explicit invalidation).
 */
export function invalidateCachedTranscript(
  threadId: string,
  threadChatId: string,
): void {
  applyCollectionWrite((collection) => {
    const id = transcriptKey(threadId, threadChatId);
    if (collection.state.has(id)) {
      collection.delete(id);
    }
  });
}
