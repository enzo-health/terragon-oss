import { useAtomValue } from "jotai";
import { useDebouncedCallback } from "use-debounce";
import { bearerTokenAtom, userAtom } from "@/atoms/user";
import {
  type BroadcastClientMessage,
  type BroadcastMessage,
  type BroadcastPreviewMessage,
  type BroadcastMessageThreadData,
  BroadcastSandboxMessage,
  type BroadcastUserMessage,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import PartySocket from "partysocket";
import { useCallback, useEffect, useState } from "react";
import { publicBroadcastHost } from "@terragon/env/next-public";
import { SandboxProvider } from "@terragon/types/sandbox";

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
}: {
  party: string;
  channel: string;
  debounceMs: number;
  matches: (message: BroadcastMessage) => boolean;
  onMessage: (message: BroadcastMessage) => void;
  disconnectOnDismount: boolean;
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

  const debouncedOnMessage = useDebouncedCallback(onMessage, debounceMs, {
    maxWait: 1000,
  });

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
    socket.addEventListener("message", onMessageWrapper);
    return () => {
      socket.removeEventListener("open", onReadyStateChange);
      socket.removeEventListener("close", onReadyStateChange);
      window.removeEventListener("online", handleOnline);
      socket.removeEventListener("message", onMessageWrapper);
    };
  }, [socket, onMessageWrapper]);

  const sendMessage = useCallback(
    (message: BroadcastClientMessage) => {
      socket?.send(JSON.stringify(message));
    },
    [socket],
  );
  return {
    sendMessage,
    socketReadyState,
  };
}

export function useRealtimeUser({
  matches,
  onMessage,
}: {
  matches: (message: BroadcastUserMessage) => boolean;
  onMessage: (message: BroadcastUserMessage) => void;
}) {
  const user = useAtomValue(userAtom);
  useRealtimeBase({
    party: "main",
    channel: getBroadcastChannelStr({
      type: "user",
      id: user?.id ?? "unknown",
    }),
    debounceMs: 1000,
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

export function useRealtimeThread(threadId: string, onChange: () => void) {
  useRealtimeUser({
    matches: useCallback(
      (args) => {
        if (args.data.threadId === threadId) {
          return true;
        }
        if (args.dataByThreadId?.[threadId]) {
          return true;
        }
        return false;
      },
      [threadId],
    ),
    onMessage: onChange,
  });
}

export type BroadcastThreadMatchThread = (
  threadId: string,
  data: BroadcastMessageThreadData,
) => boolean;

export function useRealtimeThreadMatch({
  matchThread,
  onThreadChange,
}: {
  matchThread: BroadcastThreadMatchThread;
  onThreadChange: () => void;
}) {
  useRealtimeUser({
    matches: useCallback(
      (args) => {
        if (args.data.threadId && matchThread(args.data.threadId, args.data)) {
          return true;
        }
        const dataByThreadId = args.dataByThreadId ?? {};
        for (const [threadId, data] of Object.entries(dataByThreadId)) {
          if (matchThread(threadId, data)) {
            return true;
          }
        }
        return false;
      },
      [matchThread],
    ),
    onMessage: onThreadChange,
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
  });
}

function isPreviewMessage(
  message: unknown,
): message is BroadcastPreviewMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  return (
    candidate.type === "preview" &&
    typeof candidate.previewSessionId === "string" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.threadChatId === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.userId === "string" &&
    candidate.schemaVersion === 1 &&
    typeof candidate.eventName === "string"
  );
}

export function useRealtimePreview({
  channel,
  authToken,
  enabled,
  onMessage,
}: {
  channel: string | null;
  authToken: string | null;
  enabled: boolean;
  onMessage: (message: BroadcastPreviewMessage) => void;
}) {
  const [socketReadyState, setSocketReadyState] = useState<number>(
    WebSocket.CLOSED,
  );

  useEffect(() => {
    if (!enabled || !channel || !authToken) {
      setSocketReadyState(WebSocket.CLOSED);
      return;
    }

    // Preview subscription tokens are single-use, so reconnects require reminting.
    const socket = new PartySocket({
      host: publicBroadcastHost(),
      party: "main",
      room: channel,
      maxRetries: 0,
      maxReconnectionDelay: 0,
      query: () => ({
        token: authToken,
      }),
    });

    const onReadyStateChange = () => {
      setSocketReadyState(socket.readyState);
    };

    const onSocketMessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data);
        if (isPreviewMessage(parsed)) {
          onMessage(parsed);
        }
      } catch (error) {
        console.error("[broadcast] error parsing preview message", error);
      }
    };

    socket.addEventListener("open", onReadyStateChange);
    socket.addEventListener("close", onReadyStateChange);
    socket.addEventListener("error", onReadyStateChange);
    socket.addEventListener("message", onSocketMessage);
    setSocketReadyState(socket.readyState);

    return () => {
      socket.removeEventListener("open", onReadyStateChange);
      socket.removeEventListener("close", onReadyStateChange);
      socket.removeEventListener("error", onReadyStateChange);
      socket.removeEventListener("message", onSocketMessage);
      socket.close();
    };
  }, [authToken, channel, enabled, onMessage]);

  return { socketReadyState };
}
