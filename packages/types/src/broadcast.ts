import * as z from "zod/v4";
import type { SandboxProvider } from "./sandbox";

const previewBroadcastSchemaVersion = 1 as const;
const previewEventNames = [
  "v1.preview.session.state_changed",
  "v1.preview.validation.attempt_started",
  "v1.preview.validation.attempt_finished",
  "v1.preview.access.denied",
] as const;

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

export type BroadcastChannelPreview = {
  type: "preview";
  previewSessionId: string;
  threadId: string;
  threadChatId: string;
  runId: string;
  userId: string;
  schemaVersion: number;
};

export type BroadcastChannel =
  | BroadcastChannelUser
  | BroadcastChannelSandbox
  | BroadcastChannelPreview;

const BroadcastMessageThreadDataSchema = z.object({
  isThreadUnread: z.boolean().optional(),
  isThreadCreated: z.boolean().optional(),
  isThreadDeleted: z.boolean().optional(),
  isThreadArchived: z.boolean().optional(),
  threadAutomationId: z.string().optional(),
  threadName: z.string().optional(),
  threadStatusUpdated: z.string().optional(),
  hasErrorMessage: z.boolean().optional(),
  messagesUpdated: z.boolean().optional(),
});

export type BroadcastMessageThreadData = z.infer<
  typeof BroadcastMessageThreadDataSchema
>;

const BroadcastMessageDataSchema = BroadcastMessageThreadDataSchema.extend({
  automationId: z.string().optional(),
  threadId: z.string().optional(),
  threadChatId: z.string().optional(),
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
  dataByThreadId: z
    .record(z.string(), BroadcastMessageThreadDataSchema)
    .optional(),
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

const BroadcastPreviewMessageSchema = z.object({
  type: z.literal("preview"),
  previewSessionId: z.string(),
  threadId: z.string(),
  threadChatId: z.string(),
  runId: z.string(),
  userId: z.string(),
  schemaVersion: z.literal(previewBroadcastSchemaVersion),
  eventName: z.enum(previewEventNames),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type BroadcastPreviewMessage = z.infer<
  typeof BroadcastPreviewMessageSchema
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

export type BroadcastMessage =
  | BroadcastUserMessage
  | BroadcastSandboxMessage
  | BroadcastPreviewMessage;

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
    case "preview":
      return `preview:${jsonToBase64({
        previewSessionId: channel.previewSessionId,
        threadId: channel.threadId,
        threadChatId: channel.threadChatId,
        runId: channel.runId,
        userId: channel.userId,
        schemaVersion: channel.schemaVersion,
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
      const { userId, threadId, sandboxId, sandboxProvider } = base64ToJson(id);
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
  if (type === "preview") {
    try {
      const {
        previewSessionId,
        threadId,
        threadChatId,
        runId,
        userId,
        schemaVersion,
      } = base64ToJson(id);
      if (
        !previewSessionId ||
        !threadId ||
        !threadChatId ||
        !runId ||
        !userId
      ) {
        return null;
      }
      if (schemaVersion !== previewBroadcastSchemaVersion) {
        return null;
      }
      return {
        type,
        previewSessionId,
        threadId,
        threadChatId,
        runId,
        userId,
        schemaVersion,
      };
    } catch (error) {
      console.error(
        `[broadcast] error parsing preview broadcast channel: ${id}`,
        error,
      );
      return null;
    }
  }
  return null;
}

function jsonToBase64(obj: any) {
  const jsonStr = JSON.stringify(obj);
  if (typeof btoa === "function") {
    return btoa(jsonStr);
  }
  return Buffer.from(jsonStr).toString("base64");
}

function base64ToJson(str: string) {
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
