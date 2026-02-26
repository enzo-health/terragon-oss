import { AIAgent } from "@terragon/agent/types";
import { ClaudeMessage } from "./shared";
import type { IDaemonRuntime } from "./runtime";
import type { Logger } from "./logger";

export type MessageBufferEntry = {
  message: ClaudeMessage;
  agent: AIAgent | null;
  threadId: string;
  threadChatId: string;
  runId: string | null;
  token: string;
};

/**
 * Kill a child process group if the process ID exists
 */
export function killProcessGroup(
  runtime: IDaemonRuntime,
  processId: number | null,
): void {
  if (processId) {
    runtime.logger.info("Killing process group", { pid: processId });
    runtime.killChildProcessGroup(processId);
  }
}

/**
 * Common spawn options for command execution
 */
export interface SpawnCommandOptions {
  env: Record<string, string | undefined>;
  onStdoutLine?: (line: string) => void;
  onStderr?: (line: string) => void;
  onError?: (error: any) => void;
  onClose?: (code: number | null) => void;
}

export interface IdleWatchdog {
  reset: () => void;
  clear: () => void;
  hasFired: () => boolean;
}

export function createIdleWatchdog({
  timeoutMs,
  onTimeout,
  logger,
}: {
  timeoutMs: number;
  onTimeout: () => void | Promise<void>;
  logger?: Logger;
}): IdleWatchdog {
  let timer: NodeJS.Timeout | null = null;
  let fired = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const reset = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      fired = true;
      try {
        await onTimeout();
      } catch (error) {
        logger?.error("Idle watchdog onTimeout error", { error });
      }
    }, timeoutMs);
  };

  const hasFired = () => fired;

  return { reset, clear, hasFired };
}
