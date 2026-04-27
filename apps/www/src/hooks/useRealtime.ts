import { publicBroadcastHost } from "@terragon/env/next-public";
import {
  type BroadcastClientMessage,
  type BroadcastMessage,
  type BroadcastThreadPatch,
  type BroadcastUserMessage,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import { useAtomValue } from "jotai";
import PartySocket from "partysocket";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useDebouncedCallback } from "use-debounce";
import { bearerTokenAtom, userAtom } from "@/atoms/user";
import {
  decrementRealtimeChannelUsage,
  disconnectRealtimePartySocket,
  getOrCreateRealtimePartySocket,
  incrementRealtimeChannelUsage,
} from "./realtime-socket-state";

function formatSocketReadyState(readyState: number): string {
  switch (readyState) {
    case WebSocket.CONNECTING:
      return "connecting";
    case WebSocket.OPEN:
      return "open";
    case WebSocket.CLOSING:
      return "closing";
    case WebSocket.CLOSED:
      return "closed";
    default:
      return `unknown(${readyState})`;
  }
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
      socket.addEventListener("error", () => {
        if (
          socket.readyState === WebSocket.CLOSING ||
          socket.readyState === WebSocket.CLOSED
        ) {
          return;
        }
        console.warn(
          `[broadcast] socket transport issue on channel ${channel}`,
          {
            readyState: formatSocketReadyState(socket.readyState),
            online:
              typeof navigator === "undefined" ? undefined : navigator.onLine,
          },
        );
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

// Shared realtime primitive: wraps PartySocket setup, ready-state tracking,
// and debounced message dispatch. Used internally by `useRealtimeUser` and
// by `use-realtime-sandbox.ts`. Exported so the sandbox hook (which lives in
// its own module to survive eventual deletion of the thread/user realtime
// machinery) can reuse the same socket multiplexing logic without
// duplicating it here.
export function useRealtimeBase({
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

// `useRealtimeSandbox` lives in its own module so it can survive the
// Phase 6 deletion of the thread/user realtime hooks. Re-exported here to
// preserve existing import paths.
export { useRealtimeSandbox } from "./use-realtime-sandbox";
