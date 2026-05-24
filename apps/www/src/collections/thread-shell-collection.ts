"use client";

import { useRef } from "react";
import {
  createCollection,
  localOnlyCollectionOptions,
  useLiveQuery,
  eq,
} from "@tanstack/react-db";
import { ThreadPageShell } from "@terragon/shared/db/types";
import { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { applyShellPatchFields } from "./patch-helpers";

function buildCollection() {
  return createCollection(
    localOnlyCollectionOptions<ThreadPageShell>({
      getKey: (item) => item.id,
    }),
  );
}

type ShellCollection = ReturnType<typeof buildCollection>;
type PendingCollectionWrite = (collection: ShellCollection) => void;
type PendingShellPatchQueue = {
  patches: BroadcastThreadPatch[];
  updatedAtMs: number;
};

const MAX_PENDING_SHELL_PATCHES_PER_THREAD = 50;
const MAX_PENDING_SHELL_PATCH_THREADS = 200;
const PENDING_SHELL_PATCH_TTL_MS = 30_000;

let _collection: ShellCollection | null = null;
let _pendingWrites: PendingCollectionWrite[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
// Shell patches can arrive before the initial query seed (e.g. fast WebSocket
// ticks during navigation). Preserve them until the shell exists, then apply.
let _pendingPatchesByThreadId: Map<string, PendingShellPatchQueue> = new Map();

function prunePendingShellPatches(nowMs: number): void {
  for (const [threadId, queue] of _pendingPatchesByThreadId) {
    if (nowMs - queue.updatedAtMs > PENDING_SHELL_PATCH_TTL_MS) {
      _pendingPatchesByThreadId.delete(threadId);
    }
  }
  while (_pendingPatchesByThreadId.size > MAX_PENDING_SHELL_PATCH_THREADS) {
    const oldestThread = _pendingPatchesByThreadId.keys().next();
    if (oldestThread.done) {
      return;
    }
    _pendingPatchesByThreadId.delete(oldestThread.value);
  }
}

function enqueuePendingShellPatch(patch: BroadcastThreadPatch): void {
  const nowMs = Date.now();
  prunePendingShellPatches(nowMs);
  const queue = _pendingPatchesByThreadId.get(patch.threadId) ?? {
    patches: [],
    updatedAtMs: nowMs,
  };
  queue.patches.push(patch);
  if (queue.patches.length > MAX_PENDING_SHELL_PATCHES_PER_THREAD) {
    queue.patches = queue.patches.slice(-MAX_PENDING_SHELL_PATCHES_PER_THREAD);
  }
  queue.updatedAtMs = nowMs;
  _pendingPatchesByThreadId.delete(patch.threadId);
  _pendingPatchesByThreadId.set(patch.threadId, queue);
}

function flushPendingWrites(collection: ShellCollection) {
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

export { getCollection as getThreadShellCollection };

export function applyShellPatchToCollection(patch: BroadcastThreadPatch): void {
  const write: PendingCollectionWrite = (c) => {
    if (patch.op === "delete") {
      if (c.state.has(patch.threadId)) c.delete(patch.threadId);
      _pendingPatchesByThreadId.delete(patch.threadId);
      return;
    }
    const existing = c.state.get(patch.threadId) as ThreadPageShell | undefined;
    if (!patch.shell) return;
    if (!existing) {
      enqueuePendingShellPatch(patch);
      return;
    }
    const updated = applyShellPatchFields(existing, patch.shell, patch);
    if (updated !== existing) {
      c.update(patch.threadId, (draft) => {
        Object.assign(draft, updated);
      });
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

export function seedShell(shell: ThreadPageShell): void {
  const write: PendingCollectionWrite = (c) => {
    prunePendingShellPatches(Date.now());
    const pending = _pendingPatchesByThreadId.get(shell.id)?.patches;
    const hasPending = Boolean(pending && pending.length > 0);
    let nextShell = shell;

    if (pending && pending.length > 0) {
      for (const patch of pending) {
        if (patch.op === "delete") {
          if (c.state.has(shell.id)) {
            c.delete(shell.id);
          }
          _pendingPatchesByThreadId.delete(shell.id);
          return;
        }
        if (!patch.shell) continue;
        nextShell = applyShellPatchFields(nextShell, patch.shell, patch);
      }
    }

    const existing = c.state.get(shell.id) as ThreadPageShell | undefined;
    if (existing) {
      if (!hasPending && !isIncomingShellSeedFresh(existing, nextShell)) {
        return;
      }
      c.update(shell.id, (draft) => {
        Object.assign(draft, nextShell);
      });
    } else {
      c.insert(nextShell);
    }

    if (hasPending) {
      _pendingPatchesByThreadId.delete(shell.id);
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

function isIncomingShellSeedFresh(
  existing: ThreadPageShell,
  incoming: ThreadPageShell,
): boolean {
  const existingMessageSeq = existing.primaryThreadChat.messageSeq ?? null;
  const incomingMessageSeq = incoming.primaryThreadChat.messageSeq ?? null;
  if (
    existingMessageSeq !== null &&
    incomingMessageSeq !== null &&
    incomingMessageSeq !== existingMessageSeq
  ) {
    return incomingMessageSeq > existingMessageSeq;
  }
  if (incoming.version !== null && existing.version !== null) {
    return incoming.version > existing.version;
  }
  return getTime(incoming.updatedAt) > getTime(existing.updatedAt);
}

function getTime(value: Date | string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Reactive read from TanStack DB collection. Returns undefined if not yet seeded.
 * Client-only (useLiveQuery needs useSyncExternalStore).
 */
export function useShellFromCollection(
  threadId: string,
): ThreadPageShell | undefined {
  const collectionRef = useRef(getCollection());
  const result = useLiveQuery(
    (q) =>
      q.from({ s: collectionRef.current }).where(({ s }) => eq(s.id, threadId)),
    [threadId],
  );
  return result.data?.[0] ?? undefined;
}
