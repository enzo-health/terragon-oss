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

let _collection: ShellCollection | null = null;
let _pendingWrites: PendingCollectionWrite[] = [];
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
// Shell patches can arrive before the initial query seed (e.g. fast WebSocket
// ticks during navigation). Preserve them until the shell exists, then apply.
let _pendingPatchesByThreadId: Map<string, BroadcastThreadPatch[]> = new Map();

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
      const pending = _pendingPatchesByThreadId.get(patch.threadId) ?? [];
      pending.push(patch);
      _pendingPatchesByThreadId.set(patch.threadId, pending);
      return;
    }
    const updated = applyShellPatchFields(existing, patch.shell, patch);
    if (updated !== existing) c.update(patch.threadId, () => updated);
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
    const pending = _pendingPatchesByThreadId.get(shell.id);
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

    if (c.state.has(shell.id)) {
      c.update(shell.id, () => nextShell);
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
