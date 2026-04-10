"use client";

import { useRealtimeSandbox } from "@/hooks/useRealtime";
import { useRef, useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { type BroadcastSandboxTerminalState } from "@leo/types/broadcast";
import { XtermTerminal, type XtermTerminalHandle } from "./xterm-terminal";
import isEqual from "fast-deep-equal";
import { cn } from "@/lib/utils";
import { SandboxProvider } from "@leo/types/sandbox";

export function SandboxTerminalEmbedded({
  threadId,
  sandboxId,
  sandboxProvider,
  minimized = false,
}: {
  threadId: string;
  sandboxId: string;
  sandboxProvider: SandboxProvider;
  minimized: boolean;
}) {
  const terminalRef = useRef<XtermTerminalHandle>(null);
  const [terminalState, setTerminalState] =
    useState<BroadcastSandboxTerminalState>({
      status: "initial",
      pid: null,
    });

  useEffect(() => {
    if (!minimized) {
      terminalRef.current?.focus();
    }
  }, [minimized]);

  const { sendMessage, socketReadyState } = useRealtimeSandbox({
    threadId,
    sandboxId,
    sandboxProvider,
    matches: () => true,
    onMessage: (message) => {
      const state = message.state;
      if (state.status !== terminalState.status) {
        if (state.status === "connected") {
          terminalRef.current?.focus();
          terminalRef.current?.writeMessage("Connected to sandbox.");
        } else if (state.status === "reconnecting") {
          terminalRef.current?.writeMessage(
            "Disconnected from sandbox. Reconnecting...",
          );
        } else if (state.status === "connecting") {
          terminalRef.current?.writeMessage("Connecting to sandbox.");
        } else if (state.status === "error" && state.error) {
          terminalRef.current?.writeMessage(`Error occurred: ${state.error}`);
        }
      }
      if (state.status === "initializing") {
        handleConnect();
      }
      if (!isEqual(state, terminalState)) {
        setTerminalState(state);
      }
      if (message.ptyData) {
        terminalRef.current?.write(message.ptyData);
      }
    },
  });

  useEffect(() => {
    if (
      socketReadyState === WebSocket.CLOSED &&
      terminalState.status !== "initial"
    ) {
      terminalRef.current?.writeMessage("Connection lost. Reconnecting...");
    }
  }, [socketReadyState, terminalState.status]);

  const pidOrNull = terminalState.pid;
  const isConnected =
    terminalState.status === "connected" && socketReadyState === WebSocket.OPEN;

  const handleData = (data: string) => {
    if (isConnected && pidOrNull) {
      sendMessage({
        type: "sandbox",
        id: sandboxId,
        data: { type: "sandbox-pty-input", pid: pidOrNull, input: data },
      });
    }
  };

  const handleResize = (cols: number, rows: number) => {
    if (isConnected && pidOrNull) {
      sendMessage({
        type: "sandbox",
        id: sandboxId,
        data: { type: "sandbox-pty-resize", pid: pidOrNull, cols, rows },
      });
    }
  };

  const handleConnect = () => {
    setTimeout(() => {
      terminalRef.current?.fit();
      const cols = terminalRef.current?.cols() || 80;
      const rows = terminalRef.current?.rows() || 24;
      sendMessage({
        type: "sandbox",
        id: sandboxId,
        data: { type: "sandbox-pty-connect", cols, rows },
      });
    }, 200);
  };

  return (
    <div className="h-full w-full">
      <div className="flex relative h-full flex-col">
        <div className="absolute top-0 w-full z-10">
          <SandboxTerminalBanner
            state={terminalState}
            onConnect={handleConnect}
            socketReadyState={socketReadyState}
          />
        </div>

        <div className="h-full p-2 relative">
          <XtermTerminal
            ref={terminalRef}
            onData={handleData}
            onResize={handleResize}
            disabled={!isConnected}
          />
        </div>
      </div>
    </div>
  );
}

function SandboxTerminalBanner({
  state,
  socketReadyState,
  onConnect,
}: {
  state: BroadcastSandboxTerminalState;
  socketReadyState: number;
  onConnect: () => void;
}) {
  const [isHidden, setIsHidden] = useState(false);
  const status = state.status;
  const error = state.error;

  let message = "";
  let actionLabel = "";

  if (socketReadyState !== WebSocket.OPEN) {
    if (status === "initial") {
      message = "Preparing terminal…";
    } else {
      message = "Connection lost. Reconnecting...";
    }
  } else {
    switch (status) {
      case "initial":
      case "initializing": {
        message = "Preparing terminal…";
        break;
      }
      case "connecting":
        message = "Connecting to sandbox… Please wait.";
        break;
      case "reconnecting":
        message = "Reconnecting to sandbox… Please wait.";
        break;
      case "disconnected":
        message = "Disconnected from sandbox.";
        actionLabel = "Reconnect";
        break;
      case "error":
        message = `Error${error ? ": " + error : ""}… Retrying shortly.`;
        break;
      case "connected":
        message = "Connected to sandbox.";
        break;
      default:
        const _exhaustiveCheck: never = status;
        console.error(
          "SandboxTerminalBanner: unknown status",
          _exhaustiveCheck,
        );
        break;
    }
  }

  const isLoading =
    socketReadyState !== WebSocket.OPEN ||
    status === "connecting" ||
    status === "reconnecting" ||
    status === "initializing";
  const isConnected =
    socketReadyState === WebSocket.OPEN && status === "connected";

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsHidden(isConnected);
    }, 500);
    return () => clearTimeout(timer);
  }, [isConnected]);

  return (
    <div
      className={cn(
        "mb-2 flex items-center justify-between border-b px-2 py-1 text-sm bg-muted h-10 transition-all duration-500",
        {
          "border-b-2 border-destructive": status === "error",
          "opacity-0": isConnected,
          hidden: isHidden,
        },
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("size-2 rounded-full bg-muted-foreground/50", {
            "animate-pulse": isLoading,
            "bg-destructive": status === "error",
          })}
        />
        <span>{message}</span>
      </div>
      {actionLabel ? (
        <Button variant="ghost" size="sm" onClick={onConnect}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}
