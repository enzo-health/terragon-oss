import type { BaseEvent } from "@ag-ui/core";

export type TranscriptEnvelope = {
  readonly payload: BaseEvent;
  readonly runId?: string | null;
  readonly eventId?: string;
  readonly seq?: number;
};

export type ToolCallStatus =
  | "pending"
  | "approval"
  | "running"
  | "success"
  | "error";

export type RunStatus = "running" | "completed" | "stopped" | "error";

export type RunState = {
  readonly runId: string;
  readonly status: RunStatus;
  readonly errorMessage: string | null;
};

type ItemBase = {
  readonly key: string;
  readonly runId: string | null;
  readonly seq: number;
};

export type TextItem = ItemBase & {
  readonly kind: "text";
  readonly messageId: string;
  readonly text: string;
  readonly streaming: boolean;
};

export type ReasoningStep = { readonly text: string };

export type ReasoningItem = ItemBase & {
  readonly kind: "reasoning";
  readonly messageId: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly steps: readonly ReasoningStep[];
};

export type UserContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly url: string | null }
  | { readonly type: "unknown"; readonly raw: unknown };

export type UserItem = ItemBase & {
  readonly kind: "user";
  readonly messageId: string;
  readonly content: readonly UserContentPart[];
};

export type ToolItem = ItemBase & {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly argsText: string;
  readonly parsedArgs: unknown;
  readonly result: string | null;
  readonly isError: boolean;
  readonly status: ToolCallStatus;
  readonly streamingArgs: boolean;
  readonly parentMessageId: string | null;
};

export type TerminalChunk = {
  readonly streamSeq: number;
  readonly stream: "stdout" | "stderr" | "interaction";
  readonly text: string;
};

export type TerminalItem = ItemBase & {
  readonly kind: "terminal";
  readonly terminalId: string;
  readonly chunks: readonly TerminalChunk[];
  readonly exitCode: number | null;
};

export type DiffChangeKind = "created" | "deleted" | "modified";

export type DiffItem = ItemBase & {
  readonly kind: "diff";
  readonly diffId: string;
  readonly filePath: string;
  readonly oldContent: string | null;
  readonly newContent: string;
  readonly unifiedDiff: string | null;
  readonly changeKind: DiffChangeKind;
  readonly status: "pending" | "applied" | "rejected";
};

export type PlanEntry = {
  readonly id: string | null;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly priority: "high" | "medium" | "low" | null;
};

export type PlanItem = ItemBase & {
  readonly kind: "plan";
  readonly planId: string;
  readonly entries: readonly PlanEntry[];
};

export type PermissionOption = {
  readonly kind: string;
  readonly name: string;
  readonly optionId: string;
};

export type PermissionItem = ItemBase & {
  readonly kind: "permission";
  readonly permissionRequestId: string;
  readonly title: string;
  readonly description: string | null;
  readonly options: readonly PermissionOption[];
  readonly decision: "approved" | "denied" | null;
  readonly status: "pending" | "approved" | "denied";
};

export type SourceEntry = {
  readonly url: string | null;
  readonly title: string | null;
};

export type SourcesItem = ItemBase & {
  readonly kind: "sources";
  readonly sourcesId: string;
  readonly query: string | null;
  readonly sources: readonly SourceEntry[];
};

export type DelegationActivity = {
  readonly seq: number;
  readonly text: string;
  readonly status: string | null;
};

export type DelegationItem = ItemBase & {
  readonly kind: "delegation";
  readonly delegationId: string;
  readonly agentName: string | null;
  readonly activities: readonly DelegationActivity[];
  readonly status: ToolCallStatus;
};

export type ImageItem = ItemBase & {
  readonly kind: "image";
  readonly imageId: string;
  readonly mimeType: string | null;
  readonly url: string | null;
  readonly data: string | null;
};

export type AttachmentItem = ItemBase & {
  readonly kind: "attachment";
  readonly attachmentId: string;
  readonly name: string | null;
  readonly mimeType: string | null;
  readonly url: string | null;
  readonly size: number | null;
};

export type ErrorItem = ItemBase & {
  readonly kind: "error";
  readonly errorId: string;
  readonly message: string;
  readonly stack: string | null;
};

export type TransientRetryItem = ItemBase & {
  readonly kind: "transient-retry";
  readonly retryId: string;
  readonly message: string | null;
  readonly retryAfterMs: number | null;
};

export type CompactionItem = ItemBase & {
  readonly kind: "compaction";
  readonly compactionId: string;
};

export type UnknownPartSource = "event" | "rich-part";

export type UnknownPartItem = ItemBase & {
  readonly kind: "unknown-part";
  readonly partId: string;
  readonly label: string;
  readonly source: UnknownPartSource;
  readonly name: string;
  readonly data: unknown;
};

export type TranscriptItem =
  | TextItem
  | ReasoningItem
  | UserItem
  | ToolItem
  | TerminalItem
  | DiffItem
  | PlanItem
  | PermissionItem
  | SourcesItem
  | DelegationItem
  | ImageItem
  | AttachmentItem
  | ErrorItem
  | TransientRetryItem
  | CompactionItem
  | UnknownPartItem;

export type TranscriptItemKind = TranscriptItem["kind"];

export type TranscriptState = {
  readonly items: readonly TranscriptItem[];
  readonly index: Readonly<Record<string, number>>;
  readonly versions: Readonly<Record<string, number>>;
  readonly seenEventKeys: ReadonlySet<string>;
  readonly runs: Readonly<Record<string, RunState>>;
  readonly currentRunId: string | null;
  readonly nextSeq: number;
  readonly revision: number;
};

export function createInitialTranscriptState(): TranscriptState {
  return {
    items: [],
    index: {},
    versions: {},
    seenEventKeys: new Set(),
    runs: {},
    currentRunId: null,
    nextSeq: 0,
    revision: 0,
  };
}
