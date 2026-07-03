"use client";

import type { AbstractAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { useEffect, useRef, useState } from "react";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { TranscriptStore } from "../transcript-store";
import { hydrateTranscriptFromHistory } from "./hydrate-history";

export type LiveTranscript = {
  readonly store: TranscriptStore;
  readonly isHydrating: boolean;
};

export function useLiveTranscript({
  agent,
  loadHistory,
}: {
  agent: AbstractAgent | null;
  loadHistory: () => Promise<AgUiHistoryMessagesResult>;
}): LiveTranscript {
  const storeRef = useRef<TranscriptStore | null>(null);
  if (storeRef.current === null) storeRef.current = new TranscriptStore();
  const store = storeRef.current;
  const runIdRef = useRef<string | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    if (!agent) return;
    store.reset();
    runIdRef.current = null;
    setIsHydrating(true);

    const subscription = agent.subscribe({
      onEvent: ({ event }) => {
        try {
          if (event.type === EventType.RUN_STARTED) {
            const runId = Reflect.get(event, "runId");
            if (typeof runId === "string" && runId.length > 0) {
              runIdRef.current = runId;
            }
          }
          store.apply({ payload: event, runId: runIdRef.current });
        } catch {}
      },
    });

    let cancelled = false;
    loadHistory()
      .then((result) => {
        if (cancelled) return;
        if (result.activeRunId) runIdRef.current = result.activeRunId;
        hydrateTranscriptFromHistory(store, result);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setIsHydrating(false);
      });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [agent, loadHistory, store]);

  return { store, isHydrating };
}
