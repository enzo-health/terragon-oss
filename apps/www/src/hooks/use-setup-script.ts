import { useState, useCallback } from "react";
import { useJSONStream } from "./use-json-stream";

export type SandboxOutput = {
  type: "stdout" | "stderr" | "error" | "system";
  content: string;
  timestamp: string;
};

export type SandboxSessionStatus =
  | "idle"
  | "preparing"
  | "running"
  | "completed"
  | "error";

export type UseSetupScriptOptions = {
  environmentId: string;
  onFinish?: (outputs: SandboxOutput[]) => void;
  onError?: (error: Error) => void;
  onOutputStream?: (output: SandboxOutput) => void;
};

export type SandboxSessionData = {
  sandboxId?: string;
  exitCode?: number;
};

type StreamMessage = {
  type: "output" | "status" | "data" | "complete" | "error";
  output?: SandboxOutput;
  status?: SandboxSessionStatus;
  data?: SandboxSessionData;
  error?: string;
};

export function useSetupScript({
  environmentId,
  onFinish,
  onError,
  onOutputStream,
}: UseSetupScriptOptions) {
  const [outputs, setOutputs] = useState<SandboxOutput[]>([]);
  const [status, setStatus] = useState<SandboxSessionStatus>("idle");
  const addOutput = useCallback(
    (output: SandboxOutput) => {
      setOutputs((prev) => [...prev, output]);
      onOutputStream?.(output);
    },
    [onOutputStream],
  );

  const clearOutputs = useCallback(() => {
    setOutputs([]);
  }, []);

  // JSON stream hook for streaming responses
  const {
    start: startStream,
    stop: stopStream,
    isStreaming,
    isError: isStreamError,
    error: streamError,
  } = useJSONStream<StreamMessage>({
    url: `/api/run-setup-script/stream`,
    body: { environmentId },
    onData: (streamData) => {
      if (streamData.type === "output" && streamData.output) {
        addOutput(streamData.output);
      } else if (streamData.type === "status" && streamData.status) {
        setStatus(streamData.status);
      } else if (streamData.type === "complete") {
        setStatus("completed");
        if (onFinish) {
          onFinish(outputs);
        }
      } else if (streamData.type === "error") {
        setStatus("error");
        const error = new Error(streamData.error || "Unknown error");
        const errorOutput: SandboxOutput = {
          type: "error",
          content: error.message,
          timestamp: new Date().toISOString(),
        };
        addOutput(errorOutput);
        if (onError) {
          onError(error);
        }
      }
    },
    onError: (error) => {
      setStatus("error");
      const errorOutput: SandboxOutput = {
        type: "error",
        content: error.message,
        timestamp: new Date().toISOString(),
      };
      addOutput(errorOutput);
      if (onError) {
        onError(error);
      }
    },
    onComplete: () => {
      setStatus("completed");
      if (onFinish) {
        onFinish(outputs);
      }
    },
  });

  const execute = useCallback(
    (script: string) => {
      // Clear previous outputs
      clearOutputs();
      setStatus("preparing");
      startStream({ body: { environmentId, setupScript: script } });
    },
    [clearOutputs, startStream, environmentId],
  );

  const stop = useCallback(() => {
    stopStream();
    if (status === "running" || status === "preparing") {
      setStatus("idle");
    }
  }, [stopStream, status]);

  return {
    // State
    outputs,
    status,
    // Actions
    execute,
    stop,
    clearOutputs,
    // Loading/error states
    isLoading: isStreaming || status === "preparing",
    isError: isStreamError || status === "error",
    error: streamError,
    // Helper states
    isRunning: status === "running" || status === "preparing",
    isCompleted: status === "completed",
    isIdle: status === "idle",
  };
}
