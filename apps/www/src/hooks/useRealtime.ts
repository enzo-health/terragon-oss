import { useAtomValue } from "jotai";
import { useDebouncedCallback } from "use-debounce";
import { bearerTokenAtom, userAtom } from "@/atoms/user";
import {
  type BroadcastClientMessage,
  type BroadcastMessage,
  BroadcastSandboxMessage,
  type BroadcastThreadPatch,
  type BroadcastUserMessage,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import PartySocket from "partysocket";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { publicBroadcastHost } from "@terragon/env/next-public";
import { SandboxProvider } from "@terragon/types/sandbox";
import {
  decrementRealtimeChannelUsage,
  disconnectRealtimePartySocket,
  getOrCreateRealtimePartySocket,
  incrementRealtimeChannelUsage,
} from "./realtime-socket-state";

function isMonotonicSequence(seq: number | null | undefined): boolean {
  return seq != null && seq < 1_000_000_000;
}

function getOrCreatePartySocket({
  party,
  channel,
  authToken,
}: {
  party: string;
  channel: string;
  authToken: string;
}) {
  return getOrCreateRealtimePartySocket({
    channel,
    createSocket: () => {
      const socket = new PartySocket({
        host: publicBroadcastHost(),
        party,
        room: channel,
        maxRetries: 10,
        maxReconnectionDelay: 5 * 60 * 1000,
        reconnectionDelayGrowFactor: 2,
        query: () => ({
          token: authToken,
        }),
      });
      socket.addEventListener("open", () => {
        console.log(`[broadcast] connected to channel: ${channel}`);
      });
      socket.addEventListener("close", () => {
        console.log(`[broadcast] disconnected from channel: ${channel}`);
      });
      socket.addEventListener("error", (error) => {
        console.error(`[broadcast] socket error on channel ${channel}:`, error);
      });
      return socket;
    },
  });
}

function usePartySocket({
  party,
  channel,
  authToken,
  disconnectOnDismount,
}: {
  party: string;
  channel: string;
  authToken: string;
  disconnectOnDismount: boolean;
}) {
  const [socket, setSocket] = useState<PartySocket | null>(null);
  useEffect(() => {
    if (!socket) {
      setSocket(getOrCreatePartySocket({ party, channel, authToken }));
    }
  }, [socket, party, channel, authToken]);
  useEffect(() => {
    incrementRealtimeChannelUsage(channel);
    return () => {
      const remainingUsageCount = decrementRealtimeChannelUsage(channel);
      if (remainingUsageCount === 0 && disconnectOnDismount) {
        disconnectRealtimePartySocket(channel);
      }
    };
  }, [disconnectOnDismount, channel]);
  return socket;
}

function useRealtimeBase({
  party,
  channel,
  matches,
  onMessage,
  debounceMs,
  disconnectOnDismount,
  trackReadyState = false,
}: {
  party: string;
  channel: string;
  debounceMs: number;
  matches: (message: BroadcastMessage) => boolean;
  onMessage: (message: BroadcastMessage) => void;
  disconnectOnDismount: boolean;
  trackReadyState?: boolean;
}) {
  const authToken = useAtomValue(bearerTokenAtom);
  const [socketReadyState, setSocketReadyState] = useState<number>(
    WebSocket.CONNECTING,
  );
  const socket = usePartySocket({
    party,
    channel,
    authToken: authToken!,
    disconnectOnDismount,
  });

  // Use refs for callbacks to stabilize the event listener — avoids
  // removing/re-adding the socket listener on every render.
  const matchesRef = useRef(matches);
  const onMessageRef = useRef(onMessage);
  useLayoutEffect(() => {
    matchesRef.current = matches;
    onMessageRef.current = onMessage;
  });

  const debouncedOnMessage = useDebouncedCallback(
    (msg: BroadcastMessage) => onMessageRef.current(msg),
    debounceMs,
  );

  const onMessageWrapper = useCallback(
    (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (matchesRef.current(message)) {
          if (debounceMs > 0) {
            debouncedOnMessage(message);
          } else {
            onMessageRef.current(message);
          }
        }
      } catch (error) {
        console.error(`[broadcast] error parsing message`, event.data, error);
      }
    },
    [debouncedOnMessage, debounceMs],
  );

  useEffect(() => {
    if (!socket) return;
    socket.addEventListener("message", onMessageWrapper);
    return () => {
      socket.removeEventListener("message", onMessageWrapper);
    };
  }, [socket, onMessageWrapper]);

  useEffect(() => {
    if (!socket || !trackReadyState) {
      return;
    }
    setSocketReadyState(socket.readyState);
    const onReadyStateChange = () => {
      setSocketReadyState(socket.readyState);
    };
    const handleOnline = () => {
      if (
        socket.readyState === WebSocket.CLOSED ||
        socket.readyState === WebSocket.CLOSING
      ) {
        socket.reconnect();
      }
    };
    socket.addEventListener("open", onReadyStateChange);
    socket.addEventListener("close", onReadyStateChange);
    window.addEventListener("online", handleOnline);
    return () => {
      socket.removeEventListener("open", onReadyStateChange);
      socket.removeEventListener("close", onReadyStateChange);
      window.removeEventListener("online", handleOnline);
    };
  }, [socket, trackReadyState]);

  const sendMessage = useCallback(
    (message: BroadcastClientMessage) => {
      socket?.send(JSON.stringify(message));
    },
    [socket],
  );
  return {
    sendMessage,
    socketReadyState: trackReadyState
      ? socketReadyState
      : (socket?.readyState ?? WebSocket.CLOSED),
  };
}

export function useRealtimeUser({
  matches,
  onMessage,
  debounceMs = 1000,
  trackReadyState = false,
}: {
  matches: (message: BroadcastUserMessage) => boolean;
  onMessage: (message: BroadcastUserMessage) => void;
  debounceMs?: number;
  trackReadyState?: boolean;
}) {
  const user = useAtomValue(userAtom);
  return useRealtimeBase({
    party: "main",
    channel: getBroadcastChannelStr({
      type: "user",
      id: user?.id ?? "unknown",
    }),
    debounceMs,
    matches: (message) => {
      return message.type == "user" && matches(message);
    },
    onMessage: (message) => {
      if (message.type === "user") {
        onMessage(message);
      }
    },
    disconnectOnDismount: false,
    trackReadyState,
  });
}

export function getThreadPatches(
  message: BroadcastUserMessage,
): BroadcastThreadPatch[] {
  return message.data.threadPatches ?? [];
}

export function shouldProcessThreadPatch({
  patch,
  threadId,
  threadChatId,
}: {
  patch: BroadcastThreadPatch;
  threadId: string;
  threadChatId: string | undefined;
}): boolean {
  if (patch.threadId !== threadId) {
    return false;
  }

  if (patch.shell !== undefined) {
    return true;
  }

  return (
    threadChatId == null ||
    patch.threadChatId == null ||
    patch.threadChatId === threadChatId
  );
}

const replayMessageEntrySchema = z.object({
  seq: z.number(),
  messages: z.array(z.unknown()),
});

const replayDeltaEntrySchema = z.object({
  threadId: z.string(),
  threadChatId: z.string(),
  messageId: z.string(),
  partIndex: z.number(),
  partType: z.enum(["text", "thinking"]),
  streamSeq: z.number(),
  idempotencyKey: z.string(),
  text: z.string(),
});

const replayResponseSchema = z.object({
  entries: z.array(replayMessageEntrySchema),
  deltaEntries: z.array(replayDeltaEntrySchema),
});

type ReplayResponse = z.infer<typeof replayResponseSchema>;

function parseReplayResponse(data: unknown): ReplayResponse {
  const parsedReplay = replayResponseSchema.safeParse(data);
  if (!parsedReplay.success) {
    throw new Error("Invalid /api/thread-replay response payload");
  }
  return parsedReplay.data;
}

function buildReplayPatches({
  data,
  threadId,
  threadChatId,
}: {
  data: ReplayResponse;
  threadId: string;
  threadChatId: string | undefined;
}): BroadcastThreadPatch[] {
  const replayPatches: BroadcastThreadPatch[] = [];

  if (data.entries.length > 0) {
    replayPatches.push(
      ...data.entries.map((entry) => ({
        threadId,
        ...(threadChatId ? { threadChatId } : {}),
        op: "upsert" as const,
        chatSequence: entry.seq,
        messageSeq: entry.seq,
        appendMessages: entry.messages,
      })),
    );
  }

  if (data.deltaEntries.length > 0) {
    replayPatches.push(
      ...data.deltaEntries.map((entry) => ({
        threadId: entry.threadId,
        threadChatId: entry.threadChatId,
        op: "delta" as const,
        messageId: entry.messageId,
        partIndex: entry.partIndex,
        deltaSeq: entry.streamSeq,
        deltaIdempotencyKey: entry.idempotencyKey,
        deltaKind: entry.partType,
        text: entry.text,
      })),
    );
  }

  return replayPatches;
}

export function useRealtimeThread(
  threadId: string,
  threadChatId: string | undefined,
  onThreadPatches: (patches: BroadcastThreadPatch[]) => void,
  replayBaseline?: {
    messageSeq: number | null;
    deltaSeq?: number | null;
  },
) {
  const lastMessageSeqRef = useRef<number | null>(null);
  const lastDeltaSeqRef = useRef<number | null>(null);
  const replayInFlightRef = useRef(false);
  const activeReplayContextRef = useRef<string | null>(null);
  const replayGenerationRef = useRef(0);
  const onThreadPatchesRef = useRef(onThreadPatches);
  const previousSocketReadyStateRef = useRef<number>(WebSocket.CONNECTING);
  const socketOpenCycleRef = useRef(0);
  const replayAttemptMarkerRef = useRef<string | null>(null);
  const replayAbortControllerRef = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    onThreadPatchesRef.current = onThreadPatches;
  }, [onThreadPatches]);

  const updateSequenceTrackers = useCallback(
    (patches: BroadcastThreadPatch[]) => {
      const maxMessageSeq = patches.reduce<number | null>((max, patch) => {
        const seq =
          patch.messageSeq ??
          (isMonotonicSequence(patch.chatSequence) ? patch.chatSequence : null);
        if (seq == null) return max;
        return max === null ? seq : Math.max(max, seq);
      }, null);
      if (
        maxMessageSeq != null &&
        (lastMessageSeqRef.current == null ||
          maxMessageSeq > lastMessageSeqRef.current)
      ) {
        lastMessageSeqRef.current = maxMessageSeq;
      }

      const maxDeltaSeq = patches.reduce<number | null>((max, patch) => {
        if (patch.op !== "delta" || patch.deltaSeq == null) {
          return max;
        }
        return max == null ? patch.deltaSeq : Math.max(max, patch.deltaSeq);
      }, null);
      if (
        maxDeltaSeq != null &&
        (lastDeltaSeqRef.current == null ||
          maxDeltaSeq > lastDeltaSeqRef.current)
      ) {
        lastDeltaSeqRef.current = maxDeltaSeq;
      }
    },
    [],
  );

  const applyPatches = useCallback(
    (patches: BroadcastThreadPatch[]) => {
      if (patches.length === 0) {
        return;
      }
      updateSequenceTrackers(patches);
      onThreadPatchesRef.current(patches);
    },
    [updateSequenceTrackers],
  );

  const fetchReplay = useCallback(
    async ({
      replayMessages,
      replayDeltas,
      livePatches = [],
      abortController,
    }: {
      replayMessages: boolean;
      replayDeltas: boolean;
      livePatches?: BroadcastThreadPatch[];
      abortController?: AbortController;
    }) => {
      const fromMessageSeq = replayMessages ? lastMessageSeqRef.current : null;
      const fromDeltaSeq = replayDeltas ? lastDeltaSeqRef.current : null;
      const shouldReplayMessages = fromMessageSeq != null;
      const shouldReplayDeltas = threadChatId != null && fromDeltaSeq != null;

      if (
        (!shouldReplayMessages && !shouldReplayDeltas) ||
        replayInFlightRef.current
      ) {
        applyPatches(livePatches);
        return false;
      }

      const replayGeneration = replayGenerationRef.current;
      const replayContext = activeReplayContextRef.current;
      const activeAbortController = abortController ?? new AbortController();
      if (activeAbortController.signal.aborted) {
        return false;
      }
      replayInFlightRef.current = true;
      replayAbortControllerRef.current = activeAbortController;
      const replayUrl = new URL("/api/thread-replay", window.location.origin);
      replayUrl.searchParams.set("threadId", threadId);
      if (shouldReplayMessages) {
        replayUrl.searchParams.set("fromSeq", String(fromMessageSeq));
      }
      if (shouldReplayDeltas) {
        replayUrl.searchParams.set("threadChatId", threadChatId);
        replayUrl.searchParams.set("fromDeltaSeq", String(fromDeltaSeq));
      }

      try {
        const res = await fetch(replayUrl.toString(), {
          signal: activeAbortController.signal,
        });
        const data = res.ok ? parseReplayResponse(await res.json()) : null;
        if (
          replayGenerationRef.current !== replayGeneration ||
          activeReplayContextRef.current !== replayContext
        ) {
          return false;
        }
        const replayPatches = data
          ? buildReplayPatches({ data, threadId, threadChatId })
          : [];
        const combinedPatches = [...replayPatches, ...livePatches];
        applyPatches(combinedPatches);
      } catch (error) {
        if (activeAbortController.signal.aborted) {
          return false;
        }
        if (
          replayGenerationRef.current !== replayGeneration ||
          activeReplayContextRef.current !== replayContext
        ) {
          return false;
        }
        console.warn(
          "[broadcast] replay fetch failed, applying patches directly",
          error,
        );
        applyPatches(livePatches);
      } finally {
        if (replayAbortControllerRef.current === activeAbortController) {
          replayAbortControllerRef.current = null;
        }
        if (
          replayGenerationRef.current === replayGeneration &&
          activeReplayContextRef.current === replayContext
        ) {
          replayInFlightRef.current = false;
        }
      }

      return true;
    },
    [applyPatches, threadChatId, threadId],
  );

  const { socketReadyState } = useRealtimeUser({
    debounceMs: 0,
    trackReadyState: true,
    matches: useCallback(
      (message) =>
        getThreadPatches(message).some((patch) =>
          shouldProcessThreadPatch({ patch, threadId, threadChatId }),
        ),
      [threadId, threadChatId],
    ),
    onMessage: useCallback(
      (message) => {
        const patches = getThreadPatches(message).filter((patch) =>
          shouldProcessThreadPatch({ patch, threadId, threadChatId }),
        );
        if (patches.length === 0) return;

        // Check for message seq gaps and attempt replay
        const maxIncomingSeq = patches.reduce<number | null>((max, p) => {
          const seq =
            p.messageSeq ??
            (isMonotonicSequence(p.chatSequence) ? p.chatSequence! : null);
          if (seq == null) return max;
          return max === null ? seq : Math.max(max, seq);
        }, null);

        const lastSeq = lastMessageSeqRef.current;
        const hasMessageGap =
          maxIncomingSeq !== null &&
          lastSeq !== null &&
          isMonotonicSequence(lastSeq) &&
          maxIncomingSeq > lastSeq + 1;

        // Check for token delta seq gaps and attempt replay
        const maxIncomingDeltaSeq = patches.reduce<number | null>(
          (max, patch) => {
            if (patch.op !== "delta" || patch.deltaSeq == null) {
              return max;
            }
            return max === null
              ? patch.deltaSeq
              : Math.max(max, patch.deltaSeq);
          },
          null,
        );
        const lastDeltaSeq = lastDeltaSeqRef.current;
        const hasDeltaGap =
          maxIncomingDeltaSeq !== null &&
          lastDeltaSeq !== null &&
          maxIncomingDeltaSeq > lastDeltaSeq + 1;

        const shouldReplayMessages =
          hasMessageGap && lastMessageSeqRef.current != null;
        const shouldReplayDeltas =
          hasDeltaGap &&
          threadChatId != null &&
          lastDeltaSeqRef.current != null;

        if (shouldReplayMessages || shouldReplayDeltas) {
          void fetchReplay({
            replayMessages: shouldReplayMessages,
            replayDeltas: shouldReplayDeltas,
            livePatches: patches,
          });
        } else if (
          !(hasMessageGap || hasDeltaGap) ||
          replayInFlightRef.current
        ) {
          applyPatches(patches);
        }
      },
      [applyPatches, fetchReplay, threadChatId, threadId],
    ),
  });

  useEffect(() => {
    const nextReplayContext = `${threadId}:${threadChatId ?? "no-chat"}`;
    if (activeReplayContextRef.current !== nextReplayContext) {
      replayAbortControllerRef.current?.abort();
      replayAbortControllerRef.current = null;
      activeReplayContextRef.current = nextReplayContext;
      replayGenerationRef.current += 1;
      lastMessageSeqRef.current = replayBaseline?.messageSeq ?? null;
      lastDeltaSeqRef.current = replayBaseline?.deltaSeq ?? null;
      replayInFlightRef.current = false;
      replayAttemptMarkerRef.current = null;
      return;
    }

    const baselineMessageSeq = replayBaseline?.messageSeq;
    if (
      baselineMessageSeq != null &&
      (lastMessageSeqRef.current == null ||
        baselineMessageSeq > lastMessageSeqRef.current)
    ) {
      lastMessageSeqRef.current = baselineMessageSeq;
    }

    const baselineDeltaSeq = replayBaseline?.deltaSeq;
    if (
      baselineDeltaSeq != null &&
      (lastDeltaSeqRef.current == null ||
        baselineDeltaSeq > lastDeltaSeqRef.current)
    ) {
      lastDeltaSeqRef.current = baselineDeltaSeq;
    }
  }, [
    replayBaseline?.deltaSeq,
    replayBaseline?.messageSeq,
    threadChatId,
    threadId,
  ]);

  useEffect(() => {
    return () => {
      replayAbortControllerRef.current?.abort();
      replayAbortControllerRef.current = null;
      replayInFlightRef.current = false;
      replayAttemptMarkerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (
      socketReadyState === WebSocket.OPEN &&
      previousSocketReadyStateRef.current !== WebSocket.OPEN
    ) {
      socketOpenCycleRef.current += 1;
      replayAttemptMarkerRef.current = null;
    }
    previousSocketReadyStateRef.current = socketReadyState;
  }, [socketReadyState]);

  useEffect(() => {
    if (socketReadyState !== WebSocket.OPEN) {
      return;
    }

    const replayAttemptMarker = `${activeReplayContextRef.current ?? "unknown"}:${socketOpenCycleRef.current}`;
    if (replayAttemptMarkerRef.current === replayAttemptMarker) {
      return;
    }

    const shouldReplayMessages =
      replayBaseline?.messageSeq != null || lastMessageSeqRef.current != null;
    const shouldReplayDeltas =
      replayBaseline?.deltaSeq != null || lastDeltaSeqRef.current != null;
    if (!shouldReplayMessages && !shouldReplayDeltas) {
      return;
    }

    replayAttemptMarkerRef.current = replayAttemptMarker;
    const abortController = new AbortController();
    void fetchReplay({
      replayMessages: shouldReplayMessages,
      replayDeltas: shouldReplayDeltas,
      abortController,
    });

    return () => {
      abortController.abort();
      if (replayAbortControllerRef.current === abortController) {
        replayAbortControllerRef.current = null;
      }
      replayInFlightRef.current = false;
      replayAttemptMarkerRef.current = null;
    };
  }, [
    fetchReplay,
    replayBaseline?.deltaSeq,
    replayBaseline?.messageSeq,
    socketReadyState,
  ]);
}

export type BroadcastThreadMatchThread = (
  patch: BroadcastThreadPatch,
) => boolean;

export function useRealtimeThreadMatch({
  matchThread,
  onThreadChange,
}: {
  matchThread: BroadcastThreadMatchThread;
  onThreadChange: (patches: BroadcastThreadPatch[]) => void;
}) {
  useRealtimeUser({
    debounceMs: 0,
    matches: useCallback(
      (message) =>
        getThreadPatches(message).some((patch) => matchThread(patch)),
      [matchThread],
    ),
    onMessage: (message) => {
      const patches = getThreadPatches(message).filter((patch) =>
        matchThread(patch),
      );
      if (patches.length > 0) {
        onThreadChange(patches);
      }
    },
  });
}

export function useRealtimeSandbox({
  threadId,
  sandboxId,
  sandboxProvider,
  matches,
  onMessage,
}: {
  threadId: string;
  sandboxId: string;
  sandboxProvider: SandboxProvider;
  matches: (message: BroadcastSandboxMessage) => boolean;
  onMessage: (message: BroadcastSandboxMessage) => void;
}) {
  const user = useAtomValue(userAtom);
  return useRealtimeBase({
    party: "sandbox",
    channel: getBroadcastChannelStr({
      type: "sandbox",
      userId: user?.id ?? "",
      threadId,
      sandboxId,
      sandboxProvider,
    }),
    debounceMs: 0,
    matches: (message) => message.type === "sandbox" && matches(message),
    onMessage: (message) => {
      if (message.type === "sandbox") {
        onMessage(message);
      }
    },
    disconnectOnDismount: true,
    trackReadyState: true,
  });
}
