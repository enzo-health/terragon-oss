import * as z from "zod/v4";
import type { SandboxProvider } from "./sandbox";

const BroadcastThreadStatusSchema = z.enum([
  "queued-blocked",
  "error",
  "stopped",
  "working-stopped",
  "draft",
  "scheduled",
  "queued",
  "queued-tasks-concurrency",
  "queued-sandbox-creation-rate-limit",
  "queued-agent-rate-limit",
  "booting",
  "working",
  "stopping",
  "working-error",
  "working-done",
  "checkpointing",
  "complete",
]);

const BroadcastSandboxStatusSchema = z.enum([
  "unknown",
  "provisioning",
  "booting",
  "running",
  "paused",
  "killed",
]);

const BroadcastBootingSubstatusSchema = z.enum([
  "provisioning",
  "provisioning-done",
  "cloning-repo",
  "installing-agent",
  "running-setup-script",
  "booting-done",
]);

const BroadcastGithubPRStatusSchema = z.enum([
  "draft",
  "open",
  "closed",
  "merged",
]);

const BroadcastGithubCheckStatusSchema = z.enum([
  "none",
  "pending",
  "success",
  "failure",
  "unknown",
]);

const BroadcastThreadSourceSchema = z.enum([
  "www",
  "www-redo",
  "www-fork",
  "www-multi-agent",
  "www-suggested-followup-task",
  "webhook",
  "automation",
  "slack-mention",
  "github-mention",
  "linear-mention",
  "cli",
]);

const BroadcastAIAgentSchema = z.enum([
  "claudeCode",
  "gemini",
  "amp",
  "codex",
  "opencode",
]);

export type BroadcastChannelUser = {
  type: "user";
  id: string;
};

export type BroadcastChannelSandbox = {
  type: "sandbox";
  userId: string;
  threadId: string;
  sandboxId: string;
  sandboxProvider: SandboxProvider;
};

export type BroadcastChannel = BroadcastChannelUser | BroadcastChannelSandbox;

const BroadcastGitDiffStatsSchema = z.object({
  files: z.number(),
  additions: z.number(),
  deletions: z.number(),
});

const BroadcastChildThreadInfoSchema = z.object({
  id: z.string(),
  parentToolId: z.string().nullable(),
});

const BroadcastThreadShellRealtimeFieldsSchema = z.object({
  userId: z.string().optional(),
  name: z.string().nullable().optional(),
  automationId: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  visibility: z.enum(["private", "link", "repo"]).nullable().optional(),
  isUnread: z.boolean().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  branchName: z.string().nullable().optional(),
  repoBaseBranchName: z.string().optional(),
  githubRepoFullName: z.string().optional(),
  githubPRNumber: z.number().nullable().optional(),
  githubIssueNumber: z.number().nullable().optional(),
  prStatus: BroadcastGithubPRStatusSchema.nullable().optional(),
  prChecksStatus: BroadcastGithubCheckStatusSchema.nullable().optional(),
  sandboxStatus: BroadcastSandboxStatusSchema.nullable().optional(),
  bootingSubstatus: BroadcastBootingSubstatusSchema.nullable().optional(),
  codesandboxId: z.string().nullable().optional(),
  sandboxProvider: z
    .enum(["e2b", "docker", "mock", "daytona"])
    .nullable()
    .optional(),
  sandboxSize: z.enum(["small", "large"]).nullable().optional(),
  hasGitDiff: z.boolean().optional(),
  gitDiffStats: BroadcastGitDiffStatsSchema.nullable().optional(),
  parentThreadId: z.string().nullable().optional(),
  parentThreadName: z.string().nullable().optional(),
  parentToolId: z.string().nullable().optional(),
  authorName: z.string().nullable().optional(),
  authorImage: z.string().nullable().optional(),
  draftMessage: z.unknown().nullable().optional(),
  skipSetup: z.boolean().nullable().optional(),
  disableGitCheckpointing: z.boolean().nullable().optional(),
  sourceType: BroadcastThreadSourceSchema.optional(),
  sourceMetadata: z.unknown().optional(),
  version: z.number().optional(),
  primaryThreadChatId: z.string().optional(),
  childThreads: z.array(BroadcastChildThreadInfoSchema).optional(),
});

export type BroadcastThreadShellRealtimeFields = z.infer<
  typeof BroadcastThreadShellRealtimeFieldsSchema
>;

const BroadcastActiveChatRealtimeFieldsSchema = z.object({
  agent: BroadcastAIAgentSchema.optional(),
  agentVersion: z.number().optional(),
  status: BroadcastThreadStatusSchema.nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  errorMessageInfo: z.string().nullable().optional(),
  scheduleAt: z.string().nullable().optional(),
  reattemptQueueAt: z.string().nullable().optional(),
  contextLength: z.number().nullable().optional(),
  permissionMode: z.enum(["allowAll", "plan"]).optional(),
  isUnread: z.boolean().optional(),
  queuedMessages: z.array(z.unknown()).nullable().optional(),
  updatedAt: z.string().optional(),
});

export type BroadcastActiveChatRealtimeFields = z.infer<
  typeof BroadcastActiveChatRealtimeFieldsSchema
>;

const BroadcastThreadPatchSchema = z.object({
  threadId: z.string(),
  threadChatId: z.string().optional(),
  op: z.enum(["upsert", "delete", "refetch", "delta"]),
  chatSequence: z.number().int().nonnegative().optional(),
  messageSeq: z.number().int().nonnegative().optional(),
  patchVersion: z.number().int().nonnegative().optional(),
  shell: BroadcastThreadShellRealtimeFieldsSchema.optional(),
  chat: BroadcastActiveChatRealtimeFieldsSchema.optional(),
  appendMessages: z.array(z.unknown()).optional(),
  expectedMessageCount: z.number().int().nonnegative().optional(),
  diffChanged: z.boolean().optional(),
  notifyUnread: z
    .object({
      threadName: z.string().optional(),
    })
    .optional(),
  refetch: z
    .array(z.enum(["shell", "chat", "diff", "list", "delivery-loop"]))
    .optional(),
  // Delta fields — token-level streaming with durable sequencing/replay support
  messageId: z.string().optional(),
  partIndex: z.number().int().nonnegative().optional(),
  deltaSeq: z.number().int().nonnegative().optional(),
  deltaIdempotencyKey: z.string().optional(),
  deltaKind: z.enum(["text", "thinking"]).optional(),
  text: z.string().optional(),
});

export type BroadcastThreadPatch = z.infer<typeof BroadcastThreadPatchSchema>;

const BroadcastMessageDataSchema = z.object({
  automationId: z.string().optional(),
  threadPatches: z.array(BroadcastThreadPatchSchema).optional(),
  environmentId: z.string().optional(),
  userSettings: z.boolean().optional(),
  userFlags: z.boolean().optional(),
  userCredentials: z.boolean().optional(),
  userCredits: z.boolean().optional(),
  slack: z.boolean().optional(),
  linear: z.boolean().optional(),
});

export type BroadcastMessageData = z.infer<typeof BroadcastMessageDataSchema>;

const BroadcastUserMessageSchema = z.object({
  type: z.literal("user"),
  id: z.string(),
  data: BroadcastMessageDataSchema,
});

export type BroadcastUserMessage = z.infer<typeof BroadcastUserMessageSchema>;

const BroadcastSandboxTerminalStateSchema = z.object({
  status: z.enum([
    // Initial state
    "initial",
    // initializing connection
    "initializing",

    // Attempting to connect to the sandbox
    "connecting",
    "reconnecting",

    // Connected to the sandbox
    "connected",

    // Disconnected
    "disconnected",
    "error",
  ]),
  pid: z.number().nullable(),
  error: z.string().optional(),
});

export type BroadcastSandboxTerminalState = z.infer<
  typeof BroadcastSandboxTerminalStateSchema
>;

const BroadcastSandboxMessageSchema = z.object({
  type: z.literal("sandbox"),
  id: z.string(),
  state: BroadcastSandboxTerminalStateSchema,
  ptyData: z.string().optional(),
});

export type BroadcastSandboxMessage = z.infer<
  typeof BroadcastSandboxMessageSchema
>;

export const BroadcastClientMessageSchema = z.object({
  type: z.literal("sandbox"),
  id: z.string(),
  data: z.object({
    type: z.enum([
      "sandbox-pty-connect",
      "sandbox-pty-input",
      "sandbox-pty-resize",
    ]),
    input: z.string().optional(),
    cols: z.number().optional(),
    rows: z.number().optional(),
    pid: z.number().optional(),
  }),
});

export type BroadcastClientMessage = z.infer<
  typeof BroadcastClientMessageSchema
>;

export type BroadcastMessage = BroadcastUserMessage | BroadcastSandboxMessage;

export function getBroadcastChannelStr(channel: BroadcastChannel) {
  switch (channel.type) {
    case "user":
      return `user:${channel.id}`;
    case "sandbox":
      return `sandbox:${jsonToBase64({
        userId: channel.userId,
        threadId: channel.threadId,
        sandboxId: channel.sandboxId,
        sandboxProvider: channel.sandboxProvider,
      })}`;
    default:
      const _exhaustiveCheck: never = channel;
      throw new Error("Invalid channel: " + _exhaustiveCheck);
  }
}

export function parseBroadcastChannel(
  channel: string,
): BroadcastChannel | null {
  const [type, id] = channel.split(":");
  if (!type || !id) {
    return null;
  }
  if (type === "user") {
    return { type, id };
  }
  if (type === "sandbox") {
    try {
      const parsed = base64ToJson(id);
      const parsedRecord =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : null;
      if (
        parsedRecord === null ||
        !("userId" in parsedRecord) ||
        !("threadId" in parsedRecord) ||
        !("sandboxId" in parsedRecord)
      ) {
        return null;
      }
      const userId =
        typeof parsedRecord.userId === "string"
          ? parsedRecord.userId
          : undefined;
      const threadId =
        typeof parsedRecord.threadId === "string"
          ? parsedRecord.threadId
          : undefined;
      const sandboxId =
        typeof parsedRecord.sandboxId === "string"
          ? parsedRecord.sandboxId
          : undefined;
      const sandboxProvider =
        "sandboxProvider" in parsedRecord &&
        (parsedRecord.sandboxProvider === "e2b" ||
          parsedRecord.sandboxProvider === "docker" ||
          parsedRecord.sandboxProvider === "mock" ||
          parsedRecord.sandboxProvider === "daytona")
          ? parsedRecord.sandboxProvider
          : undefined;
      if (!userId || !threadId || !sandboxId) {
        return null;
      }
      return {
        type,
        userId,
        threadId,
        sandboxId,
        sandboxProvider: sandboxProvider ?? "e2b",
      };
    } catch (error) {
      console.error(
        `[broadcast] error parsing broadcast channel: ${id}`,
        error,
      );
      return null;
    }
  }
  return null;
}

function jsonToBase64(obj: unknown) {
  const jsonStr = JSON.stringify(obj);
  if (typeof btoa === "function") {
    return btoa(jsonStr);
  }
  return Buffer.from(jsonStr).toString("base64");
}

function base64ToJson(str: string): unknown {
  try {
    const jsonStr =
      typeof atob === "function"
        ? atob(str)
        : Buffer.from(str, "base64").toString("utf-8");
    return JSON.parse(jsonStr);
  } catch (error) {
    console.error(
      `[broadcast] error parsing broadcast base64 to json: ${str}`,
      error,
    );
    throw error;
  }
}
