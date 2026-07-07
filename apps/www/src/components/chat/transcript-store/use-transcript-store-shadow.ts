import type { AbstractAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { useEffect, useRef, useState } from "react";
import { TranscriptStore } from "./transcript-store";

const LOCAL_STORAGE_FLAG = "terragon.transcriptStoreShadow";

export function isTranscriptStoreShadowEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_TRANSCRIPT_STORE_SHADOW === "1") {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(LOCAL_STORAGE_FLAG) === "1";
  } catch {
    return false;
  }
}

export function useTranscriptStoreShadow(
  agent: AbstractAgent | null,
): TranscriptStore | null {
  const [enabled] = useState(isTranscriptStoreShadowEnabled);
  const storeRef = useRef<TranscriptStore | null>(null);
  const runIdRef = useRef<string | null>(null);

  if (enabled && storeRef.current === null) {
    storeRef.current = new TranscriptStore();
  }

  useEffect(() => {
    if (!enabled || !agent) return;
    const store = storeRef.current;
    if (!store) return;

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

    return () => {
      subscription.unsubscribe();
    };
  }, [enabled, agent]);

  return enabled ? storeRef.current : null;
}
