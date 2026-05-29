import type { ClaudeMessage } from "@terragon/daemon/shared";
import type {
  DBMessage,
  DBUserMessage,
  ThreadChatInsert,
} from "@terragon/shared";
import type { FeatureFlagName } from "@terragon/shared/model/feature-flags-definitions";
import type { SandboxProvider } from "@terragon/types/sandbox";

type BroadcastUserMessage = Parameters<
  typeof import("@terragon/shared/broadcast-server").publishBroadcastUserMessage
>[0];

/**
 * Canonical return type for the daemon event handler.
 * Kept as a flat object (not a discriminated union) for backward
 * compatibility with existing callers/tests that access
 * terminalRecoveryQueued unconditionally.
 */
export type DaemonEventResult = {
  success: boolean;
  threadChatMessageSeq: number | null;
  terminalRecoveryQueued: boolean;
  error?: string;
  status?: number;
};

/**
 * Parsed classification of a daemon message batch.
 */
export type MessageClassification = {
  isStop: boolean;
  isDone: boolean;
  isError: boolean;
  isRateLimited: boolean;
  isOverloaded: boolean;
  isPromptTooLong: boolean;
  isOAuthTokenRevoked: boolean;
  rateLimitResetTime: number | undefined;
  customErrorMessage: string | null;
  sessionId: string | null;
  durationMs: number;
  costUsd: number;
};

/**
 * Mutable thread-chat update accumulator built by the router and its handlers.
 */
export type ThreadChatUpdateAccumulator = {
  appendMessages: DBMessage[];
  appendQueuedMessages?: DBUserMessage[];
  replaceQueuedMessages?: DBUserMessage[];
  sessionId: string | null;
  errorMessage: string | null;
  errorMessageInfo: string | null;
  contextLength: number | null | undefined;
};

/**
 * Runtime context for a single daemon-event invocation.
 */
export type DaemonEventContext = {
  messages: ClaudeMessage[];
  threadId: string;
  threadChatId: string;
  userId: string;
  timezone: string;
  contextUsage: number | null;
  runId: string | undefined;
  deferTerminalTransitionToRoute: boolean;
  suppressTerminalRecoverySideEffects: boolean;
  skipThreadChatPersistence: boolean;
};

/**
 * Resolved thread + threadChat objects fetched at the start of handling.
 */
export type ResolvedThreadData = {
  threadChat: Awaited<
    ReturnType<typeof import("@terragon/shared/model/threads").getThreadChat>
  >;
  thread: Awaited<
    ReturnType<typeof import("@terragon/shared/model/threads").getThreadMinimal>
  >;
};

/**
 * Dependencies injected into the router (replacing direct @/agent/* imports).
 */
export type RouterDependencies = {
  toDBMessage: (message: ClaudeMessage) => DBMessage[];
  getThreadChat: (params: {
    db: import("@terragon/shared/db").DB;
    userId: string;
    threadId: string;
    threadChatId: string;
  }) => Promise<ResolvedThreadData["threadChat"] | null>;
  getThreadMinimal: (params: {
    db: import("@terragon/shared/db").DB;
    threadId: string;
    userId: string;
  }) => Promise<ResolvedThreadData["thread"] | null>;
  touchThreadChatUpdatedAt: (params: {
    db: import("@terragon/shared/db").DB;
    threadId: string;
    threadChatId: string;
  }) => Promise<unknown>;
  updateThreadChat: (params: {
    db: import("@terragon/shared/db").DB;
    userId: string;
    threadId: string;
    threadChatId: string;
    updates: ThreadChatInsert;
    skipAppendMessagesInBroadcast?: boolean;
    skipBroadcast?: boolean;
  }) => Promise<{
    chatSequence?: number | undefined;
    broadcastData?: BroadcastUserMessage | undefined;
  }>;
  updateThreadChatWithTransition: (params: {
    userId: string;
    threadId: string;
    threadChatId: string;
    eventType: import("@/agent/machine").ThreadEvent;
    markAsUnread?: boolean;
    rateLimitResetTime?: number;
    updates?: Partial<import("@terragon/shared").ThreadInsert>;
    chatUpdates?: ThreadChatInsert;
    skipAppendMessagesInBroadcast?: boolean;
    skipBroadcast?: boolean;
  }) => Promise<{
    didUpdateStatus: boolean;
    chatSequence?: number | undefined;
    broadcastData?: BroadcastUserMessage | undefined;
  }>;
  updateThread: (params: {
    db: import("@terragon/shared/db").DB;
    userId: string;
    threadId: string;
    updates: Partial<import("@terragon/shared").ThreadInsert>;
  }) => Promise<unknown>;
  getFeatureFlagForUser: (params: {
    db: import("@terragon/shared/db").DB;
    userId: string;
    flagName: FeatureFlagName;
  }) => Promise<boolean>;
  extendSandboxLife: (params: {
    sandboxId: string;
    sandboxProvider: SandboxProvider;
  }) => Promise<unknown>;
  persistSideEffectAgUiMessages: typeof import("@/server-lib/ag-ui-side-effect-messages").persistSideEffectAgUiMessages;
  persistInvalidTokenRetrySideEffectMarker: typeof import("@/server-lib/ag-ui-side-effect-messages").persistInvalidTokenRetrySideEffectMarker;
  hasInvalidTokenRetrySideEffectMarker: typeof import("@/server-lib/ag-ui-side-effect-messages").hasInvalidTokenRetrySideEffectMarker;
  findOpenAgUiToolCallsForRun: typeof import("@terragon/shared/model/agent-event-log").findOpenAgUiToolCallsForRun;
  updateAgentRunContext: typeof import("@terragon/shared/model/agent-run-context").updateAgentRunContext;
  getAgentRunContextByRunId: typeof import("@terragon/shared/model/agent-run-context").getAgentRunContextByRunId;
  publishBroadcastUserMessage: typeof import("@terragon/shared/broadcast-server").publishBroadcastUserMessage;
  isAnthropicDownPOST: typeof import("@/server-lib/internal-request").isAnthropicDownPOST;
  internalPOST: typeof import("@/server-lib/internal-request").internalPOST;
  trackUsageEvents: typeof import("@/server-lib/usage-events").trackUsageEvents;
  compactThreadChat: typeof import("@/server-lib/compact").compactThreadChat;
  maybeProcessFollowUpQueue: typeof import("@/server-lib/process-follow-up-queue").maybeProcessFollowUpQueue;
  checkpointThread: typeof import("@/server-lib/checkpoint-thread").checkpointThread;
  getEligibleQueuedThreadChats: typeof import("@/server-lib/process-queued-thread").getEligibleQueuedThreadChats;
  hasOtherActiveRuns: (params: {
    sandboxId: string;
    threadChatId: string;
    excludeRunId: string | null;
  }) => Promise<boolean>;
  setActiveThreadChat: (params: {
    sandboxId: string;
    threadChatId: string;
    isActive: boolean;
    runId: string | null;
  }) => Promise<void>;
  emitLinearActivitiesForDaemonEvent: typeof import("@/server-lib/linear-agent-activity").emitLinearActivitiesForDaemonEvent;
  refreshLinearTokenIfNeeded: typeof import("@/server-lib/linear-oauth").refreshLinearTokenIfNeeded;
  updateAgentSession: typeof import("@/server-lib/linear-agent-activity").updateAgentSession;
};
