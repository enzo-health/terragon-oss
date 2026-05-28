import { ClaudeMessage } from "@terragon/daemon/shared";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import {
  routeDaemonEvent,
  createDefaultDependencies,
} from "./daemon-event/router";
import type { DaemonEventContext } from "./daemon-event/types";

export async function handleDaemonEvent({
  messages,
  threadId,
  threadChatId,
  userId,
  timezone,
  contextUsage,
  runId,
  runContext = null,
  deferTerminalTransitionToRoute = false,
  suppressTerminalRecoverySideEffects = false,
  skipThreadChatPersistence = false,
}: {
  messages: ClaudeMessage[];
  threadId: string;
  threadChatId: string;
  userId: string;
  timezone: string;
  contextUsage: number | null;
  runId?: string;
  runContext?: Awaited<ReturnType<typeof getAgentRunContextByRunId>> | null;
  deferTerminalTransitionToRoute?: boolean;
  suppressTerminalRecoverySideEffects?: boolean;
  skipThreadChatPersistence?: boolean;
}) {
  const ctx: DaemonEventContext = {
    messages,
    threadId,
    threadChatId,
    userId,
    timezone,
    contextUsage,
    runId,
    deferTerminalTransitionToRoute,
    suppressTerminalRecoverySideEffects,
    skipThreadChatPersistence,
  };
  return routeDaemonEvent(createDefaultDependencies(), ctx);
}
