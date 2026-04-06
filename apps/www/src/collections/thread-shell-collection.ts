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

let _collection: ReturnType<typeof buildCollection> | null = null;

function getCollection() {
  if (!_collection) _collection = buildCollection();
  return _collection;
}

export { getCollection as getThreadShellCollection };

export function applyShellPatchToCollection(patch: BroadcastThreadPatch): void {
  const c = getCollection();
  if (c.status !== "ready") return;
  if (patch.op === "delete") {
    if (c.state.has(patch.threadId)) c.delete(patch.threadId);
    return;
  }
  const existing = c.state.get(patch.threadId) as ThreadPageShell | undefined;
  if (!existing || !patch.shell) return;
  const updated = applyShellPatchFields(existing, patch.shell, patch);
  if (updated !== existing) c.update(patch.threadId, () => updated);
}

export function seedShell(shell: ThreadPageShell): void {
  const c = getCollection();
  if (c.status !== "ready") return;
  if (c.state.has(shell.id)) {
    c.update(shell.id, () => shell);
  } else {
    c.insert(shell);
  }
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
