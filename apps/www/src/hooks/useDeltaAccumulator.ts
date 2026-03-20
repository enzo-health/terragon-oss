"use client";

import { useCallback, useRef, useState } from "react";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";

/** Key format: `${messageId}:${partIndex}` */
export type DeltaKey = string;

export type DeltaAccumulator = Map<DeltaKey, string>;

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

  const applyDelta = useCallback((patch: BroadcastThreadPatch) => {
    if (
      patch.op !== "delta" ||
      !patch.messageId ||
      patch.partIndex == null ||
      !patch.text
    ) {
      return;
    }
    setDeltas((prev) => {
      const key = makeDeltaKey(patch.messageId!, patch.partIndex!);
      const next = new Map(prev);
      next.set(key, (prev.get(key) ?? "") + patch.text!);
      deltasRef.current = next;
      return next;
    });
  }, []);

  const clearDeltasForThread = useCallback(() => {
    if (deltasRef.current.size === 0) return;
    setDeltas(new Map());
    deltasRef.current = new Map();
  }, []);

  return { deltas, applyDelta, clearDeltasForThread } as const;
}
