import type {
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadUserMessagePart,
} from "@assistant-ui/react";
import type { DBTerminalPart } from "@terragon/shared";
import {
  isTerminalPart,
  terragonDataPayload,
  type RuntimeToolCallPartWithLifecycle,
} from "./runtime-part-conversion";

export type RuntimeMessageSnapshot = {
  role: ThreadMessage["role"];
  parts: RuntimePartSnapshot[];
};
export type RuntimePartSnapshot =
  | { type: "text" | "reasoning"; text: string }
  | { type: "image"; image: string }
  | {
      type: "file";
      mimeType: string;
      filename: string | undefined;
      data: string;
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: string;
      hasResult: boolean;
      result: string | null;
      isError: boolean;
      progressChunkCount: number;
      progressLastSeq: number | null;
      progressLastText: string | null;
      progressHiddenCount: number;
      toolStatus: string | null;
      artifact: string | null;
    }
  | { type: "data"; name: string; data: string }
  | { type: "source"; value: string }
  | { type: "audio"; audio: string };

export function createRuntimeMessageSnapshot(
  message: ThreadMessage,
): RuntimeMessageSnapshot {
  return {
    role: message.role,
    parts: message.content.map(runtimeMessagePartSnapshot),
  };
}

function runtimeMessagePartSnapshot(
  part: ThreadAssistantMessagePart | ThreadUserMessagePart,
): RuntimePartSnapshot {
  switch (part.type) {
    case "text":
    case "reasoning":
      return { type: part.type, text: part.text };
    case "image":
      return { type: "image", image: part.image };
    case "file":
      return {
        type: "file",
        mimeType: part.mimeType,
        filename: part.filename,
        data: part.data,
      };
    case "tool-call":
      const progressChunks =
        (part as RuntimeToolCallPartWithLifecycle).progressChunks ?? [];
      const lastProgressChunk = progressChunks.at(-1);
      return {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        args: runtimeValueFingerprint(part.args),
        hasResult: part.result !== undefined,
        result:
          part.result === undefined
            ? null
            : runtimeValueFingerprint(part.result),
        isError: part.isError === true,
        progressChunkCount: progressChunks.length,
        progressLastSeq: lastProgressChunk?.seq ?? null,
        progressLastText: lastProgressChunk?.text ?? null,
        progressHiddenCount:
          (part as RuntimeToolCallPartWithLifecycle).progressHiddenCount ?? 0,
        toolStatus:
          (part as RuntimeToolCallPartWithLifecycle).toolStatus ?? null,
        artifact: runtimeArtifactFingerprint(
          (part as RuntimeToolCallPartWithLifecycle).artifact,
        ),
      };
    case "data":
      return {
        type: "data",
        name: part.name,
        data: runtimeDataPartFingerprint(part),
      };
    case "source":
      return { type: "source", value: runtimeValueFingerprint(part) };
    case "audio":
      return {
        type: "audio",
        audio: runtimeValueFingerprint(part.audio),
      };
  }
}

export function sameRuntimeMessageSnapshot(
  left: RuntimeMessageSnapshot,
  right: RuntimeMessageSnapshot,
): boolean {
  if (left.role !== right.role || left.parts.length !== right.parts.length) {
    return false;
  }
  for (let index = 0; index < left.parts.length; index += 1) {
    if (!sameRuntimePartSnapshot(left.parts[index]!, right.parts[index]!)) {
      return false;
    }
  }
  return true;
}

export function sameRuntimePartSnapshot(
  left: RuntimePartSnapshot,
  right: RuntimePartSnapshot,
): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "text":
    case "reasoning":
      return right.type === left.type && left.text === right.text;
    case "image":
      return right.type === "image" && left.image === right.image;
    case "file":
      return (
        right.type === "file" &&
        left.mimeType === right.mimeType &&
        left.filename === right.filename &&
        left.data === right.data
      );
    case "tool-call":
      return (
        right.type === "tool-call" &&
        left.toolCallId === right.toolCallId &&
        left.toolName === right.toolName &&
        left.args === right.args &&
        left.hasResult === right.hasResult &&
        left.result === right.result &&
        left.isError === right.isError &&
        left.progressChunkCount === right.progressChunkCount &&
        left.progressLastSeq === right.progressLastSeq &&
        left.progressLastText === right.progressLastText &&
        left.progressHiddenCount === right.progressHiddenCount &&
        left.toolStatus === right.toolStatus &&
        left.artifact === right.artifact
      );
    case "data":
      return (
        right.type === "data" &&
        left.name === right.name &&
        left.data === right.data
      );
    case "source":
      return right.type === "source" && left.value === right.value;
    case "audio":
      return right.type === "audio" && left.audio === right.audio;
  }
}

function runtimeValueFingerprint(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value !== "object") return JSON.stringify(value) ?? "";
  let fingerprint: string;
  if (Array.isArray(value)) {
    fingerprint = `[${value.map(runtimeValueFingerprint).join(",")}]`;
  } else {
    fingerprint = `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${runtimeValueFingerprint(entry)}`,
      )
      .join(",")}}`;
  }
  return fingerprint;
}

function runtimeArtifactFingerprint(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return runtimeValueFingerprint(compactArtifactFingerprintValue(value));
}

function compactArtifactFingerprintValue(value: unknown): unknown {
  if (typeof value === "string") return compactArtifactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return {
      length: value.length,
      first: compactArtifactFingerprintValue(value[0]),
      last: compactArtifactFingerprintValue(value.at(-1)),
    };
  }
  const record = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of [
    "type",
    "id",
    "artifactId",
    "artifactType",
    "status",
    "uri",
    "url",
    "image_url",
    "image",
    "pdf_url",
    "file_url",
    "filename",
    "mime_type",
    "mimeType",
    "size",
    "contentHash",
    "version",
    "title",
    "summary",
  ]) {
    if (key in record) {
      compact[key] = compactArtifactFingerprintValue(record[key]);
    }
  }
  if (Array.isArray(record.parts)) {
    compact.parts = compactArtifactFingerprintValue(record.parts);
  }
  if (Array.isArray(record.nodes)) {
    compact.nodes = compactArtifactSequenceFingerprint(record.nodes);
  }
  if (Array.isArray(record.entries)) {
    compact.entries = compactArtifactSequenceFingerprint(record.entries);
  }
  if (typeof record.planText === "string") {
    compact.planText = compactArtifactString(record.planText);
  }
  return compact;
}

function compactArtifactSequenceFingerprint(value: unknown[]): unknown {
  return {
    length: value.length,
    first: compactArtifactFingerprintValue(value[0]),
    last: compactArtifactFingerprintValue(value.at(-1)),
  };
}

function compactArtifactString(value: string): string {
  if (value.length <= 256) return value;
  return `${value.slice(0, 128)}:${value.length}:${value.slice(-128)}`;
}

function runtimeDataPartFingerprint(
  part: Extract<ThreadAssistantMessagePart, { type: "data" }>,
): string {
  const payload = terragonDataPayload(part);
  if (!payload) {
    return runtimeValueFingerprint(part.data);
  }

  if (payload.name === "terragon.terminal" && isTerminalPart(payload.data)) {
    return terminalPartFingerprint(payload.data);
  }

  return runtimeValueFingerprint(part.data);
}

function terminalPartFingerprint(part: DBTerminalPart): string {
  const lastChunk = part.chunks.at(-1);
  return runtimeValueFingerprint({
    type: part.type,
    sandboxId: part.sandboxId,
    terminalId: part.terminalId,
    chunksLength: part.chunks.length,
    lastStreamSeq: lastChunk?.streamSeq ?? null,
    lastKind: lastChunk?.kind ?? null,
    lastText: lastChunk?.text ?? null,
    chunksHash: terminalChunksHash(part.chunks),
  });
}

function terminalChunksHash(chunks: DBTerminalPart["chunks"]): number {
  let hash = 0;
  for (const chunk of chunks) {
    hash = hashStringIntoHash(hash, String(chunk.streamSeq));
    hash = hashStringIntoHash(hash, chunk.kind);
    hash = hashStringIntoHash(hash, chunk.text);
  }
  return hash >>> 0;
}

function hashStringIntoHash(initialHash: number, value: string): number {
  let hash = initialHash;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}
