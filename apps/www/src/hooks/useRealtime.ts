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
import { useCallback, useEffect, useRef, useState } from "react";
import { publicBroadcastHost } from "@terragon/env/next-public";
import { SandboxProvider } from "@terragon/types/sandbox";

function isMonotonicSequence(seq: number | null | undefined): boolean {
  return seq != null && seq < 1_000_000_000;
}

const usageCountByChannel: Record<string, number> = {};
const partykitByChannel: Record<string, PartySocket> = {};

function getOrCreatePartySocket({
  party,
  channel,
  authToken,
}: {
  party: string;
  channel: string;
  authToken: string;
}) {
  if (!partykitByChannel[channel]) {
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
    partykitByChannel[channel] = socket;
  }
  return partykitByChannel[channel];
}

function disconnectPartySocket(channel: string) {
  const socket = partykitByChannel[channel];
  if (socket) {
    socket.close();
    delete partykitByChannel[channel];
  }
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
    usageCountByChannel[channel] = (usageCountByChannel[channel] || 0) + 1;
    return () => {
      usageCountByChannel[channel] = (usageCountByChannel[channel] || 0) - 1;
      if (usageCountByChannel[channel] === 0 && disconnectOnDismount) {
        disconnectPartySocket(channel);
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

  const debouncedOnMessage = useDebouncedCallback(onMessage, debounceMs);

  const onMessageWrapper = useCallback(
    (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data);
        if (matches(message)) {
          if (debounceMs > 0) {
            debouncedOnMessage(message);
          } else {
            onMessage(message);
          }
        }
      } catch (error) {
        console.error(`[broadcast] error parsing message`, event.data, error);
      }
    },
    [debouncedOnMessage, matches, debounceMs, onMessage],
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
}: {
  matches: (message: BroadcastUserMessage) => boolean;
  onMessage: (message: BroadcastUserMessage) => void;
  debounceMs?: number;
}) {
  const user = useAtomValue(userAtom);
  useRealtimeBase({
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
  });
}

export function getThreadPatches(
  message: BroadcastUserMessage,
): BroadcastThreadPatch[] {
  return message.data.threadPatches ?? [];
}

export function useRealtimeThread(
  threadId: string,
  threadChatId: string | undefined,
  onThreadPatches: (patches: BroadcastThreadPatch[]) => void,
) {
  const lastMessageSeqRef = useRef<number | null>(null);
  const lastDeltaSeqRef = useRef<number | null>(null);
  const replayInFlightRef = useRef(false);

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

  useRealtimeUser({
    debounceMs: 0,
    matches: useCallback(
      (message) =>
        getThreadPatches(message).some(
          (patch) =>
            patch.threadId === threadId &&
            (threadChatId == null ||
              patch.threadChatId == null ||
              patch.threadChatId === threadChatId),
        ),
      [threadId, threadChatId],
    ),
    onMessage: useCallback(
      (message) => {
        const patches = getThreadPatches(message).filter(
          (patch) =>
            patch.threadId === threadId &&
            (threadChatId == null ||
              patch.threadChatId == null ||
              patch.threadChatId === threadChatId),
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

        if (
          (shouldReplayMessages || shouldReplayDeltas) &&
          !replayInFlightRef.current
        ) {
          replayInFlightRef.current = true;
          const replayUrl = new URL(
            "/api/thread-replay",
            window.location.origin,
          );
          replayUrl.searchParams.set("threadId", threadId);
          if (shouldReplayMessages) {
            replayUrl.searchParams.set(
              "fromSeq",
              String(lastMessageSeqRef.current),
            );
          }
          if (shouldReplayDeltas) {
            replayUrl.searchParams.set("threadChatId", threadChatId);
            replayUrl.searchParams.set(
              "fromDeltaSeq",
              String(lastDeltaSeqRef.current),
            );
          }
          fetch(replayUrl.toString())
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              const replayPatches: BroadcastThreadPatch[] = [];
              if (data?.entries?.length > 0) {
                // Build synthetic patches from replayed entries
                replayPatches.push(
                  ...data.entries.map(
                    (entry: { seq: number; messages: unknown[] }) => ({
                      threadId,
                      ...(threadChatId ? { threadChatId } : {}),
                      op: "upsert" as const,
                      chatSequence: entry.seq,
                      messageSeq: entry.seq,
                      appendMessages: entry.messages,
                    }),
                  ),
                );
              }

              if (data?.deltaEntries?.length > 0) {
                replayPatches.push(
                  ...data.deltaEntries.map(
                    (entry: {
                      threadId: string;
                      threadChatId: string;
                      messageId: string;
                      partIndex: number;
                      partType: string;
                      streamSeq: number;
                      idempotencyKey: string;
                      text: string;
                    }) => ({
                      threadId: entry.threadId,
                      threadChatId: entry.threadChatId,
                      op: "delta" as const,
                      messageId: entry.messageId,
                      partIndex: entry.partIndex,
                      deltaSeq: entry.streamSeq,
                      deltaIdempotencyKey: entry.idempotencyKey,
                      deltaKind:
                        entry.partType === "thinking" ? "thinking" : "text",
                      text: entry.text,
                    }),
                  ),
                );
              }

              const combinedPatches = [...replayPatches, ...patches];
              updateSequenceTrackers(combinedPatches);
              onThreadPatches(combinedPatches);
            })
            .catch((error) => {
              console.warn(
                "[broadcast] replay fetch failed, applying patches directly",
                error,
              );
              updateSequenceTrackers(patches);
              onThreadPatches(patches);
            })
            .finally(() => {
              replayInFlightRef.current = false;
            });
        } else if (
          !(hasMessageGap || hasDeltaGap) ||
          replayInFlightRef.current
        ) {
          updateSequenceTrackers(patches);
          onThreadPatches(patches);
        }
      },
      [threadId, threadChatId, onThreadPatches, updateSequenceTrackers],
    ),
  });
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
