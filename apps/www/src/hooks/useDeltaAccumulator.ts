"use client";

import { useCallback, useRef, useState } from "react";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";

/** Key format: `${messageId}:${partIndex}` */
export type DeltaKey = string;

export type DeltaChunk = {
  kind: "text" | "thinking";
  text: string;
};

export type DeltaAccumulator = Map<DeltaKey, DeltaChunk>;

function makeDeltaKey(messageId: string, partIndex: number): DeltaKey {
  return `${messageId}:${partIndex}`;
}

/**
 * Manages ephemeral delta text that streams in via broadcast before the full
 * DB message arrives. Deltas are keyed by `messageId:partIndex` and cleared
 * when a non-delta patch delivers the complete message.
 */
export function useDeltaAccumulator() {
  const [deltas, setDeltas] = useState<DeltaAccumulator>(new Map());
  // Ref mirrors state for synchronous reads inside the patch callback
  const deltasRef = useRef<DeltaAccumulator>(deltas);
  const maxDeltaSeqByKeyRef = useRef<Map<DeltaKey, number>>(new Map());
  const seenIdempotencyKeysRef = useRef<Set<string>>(new Set());

  const applyDelta = useCallback((patch: BroadcastThreadPatch) => {
    if (
      patch.op !== "delta" ||
      !patch.messageId ||
      patch.partIndex == null ||
      !patch.text
    ) {
      return;
    }

    if (patch.deltaIdempotencyKey) {
      if (seenIdempotencyKeysRef.current.has(patch.deltaIdempotencyKey)) {
        return;
      }
      seenIdempotencyKeysRef.current.add(patch.deltaIdempotencyKey);
    }

    const kind = patch.deltaKind === "thinking" ? "thinking" : "text";
    const text = patch.text;
    const key = makeDeltaKey(patch.messageId, patch.partIndex);
    if (patch.deltaSeq != null) {
      const maxAppliedSeq = maxDeltaSeqByKeyRef.current.get(key);
      if (maxAppliedSeq != null && patch.deltaSeq <= maxAppliedSeq) {
        return;
      }
      maxDeltaSeqByKeyRef.current.set(key, patch.deltaSeq);
    }

    setDeltas((prev) => {
      const next = new Map(prev);
      const prevChunk = prev.get(key);
      if (!prevChunk) {
        next.set(key, { kind, text });
      } else if (prevChunk.kind === kind) {
        next.set(key, { kind, text: prevChunk.text + text });
      } else {
        // If semantic kind flips for the same key, prefer latest payload.
        next.set(key, { kind, text });
      }
      deltasRef.current = next;
      return next;
    });
  }, []);

  const clearDeltasForThread = useCallback(() => {
    if (deltasRef.current.size === 0) return;
    setDeltas(new Map());
    deltasRef.current = new Map();
    maxDeltaSeqByKeyRef.current = new Map();
    seenIdempotencyKeysRef.current = new Set();
  }, []);

  return { deltas, applyDelta, clearDeltasForThread } as const;
}
