import { createHash } from "node:crypto";
import type { GitDiffStats } from "./types";
import type {
  UIGitDiffPart,
  UIImagePart,
  UIMessage,
  UIPart,
  UIPdfPart,
  UIRichTextPart,
  UITextFilePart,
} from "./ui-messages";

export type ArtifactDescriptorKind = "git-diff" | "document" | "file" | "media";

export type ArtifactDescriptorStatus = "ready";

type MessageArtifactPart = UIRichTextPart | UIImagePart | UIPdfPart | UITextFilePart;

export type ArtifactDescriptorPart = UIGitDiffPart | MessageArtifactPart;

type ToolCallOrigin = {
  id: string;
  name: string;
};

export type ArtifactDescriptorOrigin =
  | {
      type: "thread";
      threadId: string;
      field: "gitDiff";
    }
  | {
      type: "user-message-part";
      messageTimestamp?: string;
      partType: MessageArtifactPart["type"];
      fingerprint: string;
    }
  | {
      type: "tool-part";
      toolCallId: string;
      toolCallName: string;
      toolCallPath: string[];
      partType: MessageArtifactPart["type"];
      fingerprint: string;
    }
  | {
      type: "system-message";
      messageType: "git-diff";
      timestamp?: string;
      fingerprint: string;
    };

type MessageArtifactOrigin = Extract<
  ArtifactDescriptorOrigin,
  { type: "user-message-part" | "tool-part" }
>;

type BaseArtifactDescriptor<
  TKind extends ArtifactDescriptorKind,
  TPart extends ArtifactDescriptorPart,
> = {
  id: string;
  kind: TKind;
  title: string;
  status: ArtifactDescriptorStatus;
  part: TPart;
  origin: ArtifactDescriptorOrigin;
  updatedAt?: string;
  summary?: string;
};

export type GitDiffArtifactDescriptor = BaseArtifactDescriptor<
  "git-diff",
  UIGitDiffPart
>;

export type DocumentArtifactDescriptor = BaseArtifactDescriptor<
  "document",
  UIRichTextPart
>;

export type FileArtifactDescriptor = BaseArtifactDescriptor<
  "file",
  UITextFilePart
>;

export type MediaArtifactDescriptor = BaseArtifactDescriptor<
  "media",
  UIImagePart | UIPdfPart
>;

export type ArtifactDescriptor =
  | GitDiffArtifactDescriptor
  | DocumentArtifactDescriptor
  | FileArtifactDescriptor
  | MediaArtifactDescriptor;

export type ArtifactDescriptorThreadInput = {
  id: string;
  updatedAt?: Date | string | null;
  gitDiff?: string | null;
  gitDiffStats?: GitDiffStats | null;
};

/**
 * Derives artifact descriptors from the canonical UI message model plus
 * optional thread-level git diff state. Agent-backed artifacts are only emitted
 * when they are anchored to a stable tool-call id; top-level streamed agent
 * parts are intentionally omitted until the source model exposes a durable id.
 */
export function getArtifactDescriptors({
  messages,
  thread,
}: {
  messages: UIMessage[];
  thread?: ArtifactDescriptorThreadInput | null;
}): ArtifactDescriptor[] {
  const descriptors: ArtifactDescriptor[] = [];
  const duplicateCounts = new Map<string, number>();

  if (thread?.gitDiff) {
    descriptors.push({
      id: buildThreadGitDiffArtifactId(thread.id),
      kind: "git-diff",
      title: "Current changes",
      status: "ready",
      part: {
        type: "git-diff",
        diff: thread.gitDiff,
        diffStats: thread.gitDiffStats ?? undefined,
      },
      origin: {
        type: "thread",
        threadId: thread.id,
        field: "gitDiff",
      },
      updatedAt: normalizeTimestamp(thread.updatedAt),
      summary: buildGitDiffSummary(thread.gitDiffStats ?? undefined),
    });
  }

  for (const message of messages) {
    if (message.role === "system") {
      if (message.message_type !== "git-diff") {
        continue;
      }

      for (const part of message.parts) {
        const fingerprint = getGitDiffFingerprint(part);
        descriptors.push({
          id: buildStableId({
            baseId: buildSystemGitDiffArtifactBaseId({
              timestamp: part.timestamp,
              fingerprint,
            }),
            duplicateCounts,
          }),
          kind: "git-diff",
          title: part.description?.trim() || "Diff checkpoint",
          status: "ready",
          part,
          origin: {
            type: "system-message",
            messageType: "git-diff",
            timestamp: part.timestamp,
            fingerprint,
          },
          updatedAt: part.timestamp,
          summary: buildGitDiffSummary(part.diffStats),
        });
      }

      continue;
    }

    collectArtifactDescriptorsFromParts({
      descriptors,
      duplicateCounts,
      parts: message.parts,
      messageRole: message.role,
      messageTimestamp:
        message.role === "user" ? normalizeTimestamp(message.timestamp) : undefined,
      toolPath: [],
    });
  }

  return descriptors;
}

function collectArtifactDescriptorsFromParts({
  descriptors,
  duplicateCounts,
  parts,
  messageRole,
  messageTimestamp,
  toolPath,
}: {
  descriptors: ArtifactDescriptor[];
  duplicateCounts: Map<string, number>;
  parts: UIPart[];
  messageRole: "user" | "agent";
  messageTimestamp?: string;
  toolPath: ToolCallOrigin[];
}) {
  for (const part of parts) {
    if (part.type === "tool") {
      collectArtifactDescriptorsFromParts({
        descriptors,
        duplicateCounts,
        parts: part.parts,
        messageRole,
        messageTimestamp,
        toolPath: [...toolPath, { id: part.id, name: part.name }],
      });
      continue;
    }

    if (!isMessageArtifactPart(part)) {
      continue;
    }

    const descriptor = buildMessageArtifactDescriptor({
      part,
      messageRole,
      messageTimestamp,
      toolPath,
      duplicateCounts,
    });

    if (descriptor) {
      descriptors.push(descriptor);
    }
  }
}

function buildMessageArtifactDescriptor({
  part,
  messageRole,
  messageTimestamp,
  toolPath,
  duplicateCounts,
}: {
  part: MessageArtifactPart;
  messageRole: "user" | "agent";
  messageTimestamp?: string;
  toolPath: ToolCallOrigin[];
  duplicateCounts: Map<string, number>;
}): ArtifactDescriptor | null {
  const fingerprint = getMessageArtifactFingerprint(part);

  if (toolPath.length > 0) {
    const leafTool = toolPath[toolPath.length - 1]!;
    return createDescriptor({
      part,
      id: buildStableId({
        baseId: buildToolArtifactBaseId({ toolPath, part, fingerprint }),
        duplicateCounts,
      }),
      origin: {
        type: "tool-part",
        toolCallId: leafTool.id,
        toolCallName: leafTool.name,
        toolCallPath: toolPath.map((tool) => tool.id),
        partType: part.type,
        fingerprint,
      },
    });
  }

  if (messageRole !== "user") {
    return null;
  }

  return createDescriptor({
    part,
    id: buildStableId({
      baseId: buildUserArtifactBaseId({
        messageTimestamp,
        part,
        fingerprint,
      }),
      duplicateCounts,
    }),
    origin: {
      type: "user-message-part",
      messageTimestamp,
      partType: part.type,
      fingerprint,
    },
    updatedAt: messageTimestamp,
  });
}

function createDescriptor({
  part,
  id,
  origin,
  updatedAt,
}: {
  part: MessageArtifactPart;
  id: string;
  origin: MessageArtifactOrigin;
  updatedAt?: string;
}): ArtifactDescriptor {
  switch (part.type) {
    case "rich-text":
      return {
        id,
        kind: "document",
        title: "Document",
        status: "ready",
        part,
        origin,
        updatedAt,
        summary: summarizeRichText(part),
      };
    case "text-file":
      return {
        id,
        kind: "file",
        title: part.filename?.trim() || "Text file",
        status: "ready",
        part,
        origin,
        updatedAt,
        summary: part.mime_type,
      };
    case "image":
      return {
        id,
        kind: "media",
        title: "Image",
        status: "ready",
        part,
        origin,
        updatedAt,
      };
    case "pdf":
      return {
        id,
        kind: "media",
        title: part.filename?.trim() || "PDF",
        status: "ready",
        part,
        origin,
        updatedAt,
      };
  }
}

function isMessageArtifactPart(part: UIPart): part is MessageArtifactPart {
  return (
    part.type === "image" ||
    part.type === "rich-text" ||
    part.type === "pdf" ||
    part.type === "text-file"
  );
}

function buildThreadGitDiffArtifactId(threadId: string): string {
  return `artifact:thread:${threadId}:git-diff`;
}

function buildSystemGitDiffArtifactBaseId({
  timestamp,
  fingerprint,
}: {
  timestamp?: string;
  fingerprint: string;
}): string {
  return `artifact:system:git-diff:${timestamp ?? fingerprint}`;
}

function buildUserArtifactBaseId({
  messageTimestamp,
  part,
  fingerprint,
}: {
  messageTimestamp?: string;
  part: MessageArtifactPart;
  fingerprint: string;
}): string {
  return `artifact:user:${messageTimestamp ?? "untimed"}:${part.type}:${fingerprint}`;
}

function buildToolArtifactBaseId({
  toolPath,
  part,
  fingerprint,
}: {
  toolPath: ToolCallOrigin[];
  part: MessageArtifactPart;
  fingerprint: string;
}): string {
  return `artifact:tool:${toolPath.map((tool) => tool.id).join("/")}:${part.type}:${fingerprint}`;
}

function buildStableId({
  baseId,
  duplicateCounts,
}: {
  baseId: string;
  duplicateCounts: Map<string, number>;
}): string {
  const count = duplicateCounts.get(baseId) ?? 0;
  duplicateCounts.set(baseId, count + 1);
  return count === 0 ? baseId : `${baseId}:${count + 1}`;
}

function getMessageArtifactFingerprint(part: MessageArtifactPart): string {
  switch (part.type) {
    case "rich-text":
      return shortHash(part.nodes);
    case "text-file":
      return shortHash({
        file_url: part.file_url,
        filename: part.filename,
        mime_type: part.mime_type,
      });
    case "image":
      return shortHash({ image_url: part.image_url });
    case "pdf":
      return shortHash({ pdf_url: part.pdf_url, filename: part.filename });
  }
}

function getGitDiffFingerprint(part: UIGitDiffPart): string {
  return shortHash({
    diff: part.diff,
    diffStats: part.diffStats,
    description: part.description,
  });
}

function shortHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function normalizeTimestamp(timestamp?: Date | string | null): string | undefined {
  if (!timestamp) {
    return undefined;
  }
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}

function buildGitDiffSummary(diffStats?: GitDiffStats): string | undefined {
  if (!diffStats) {
    return undefined;
  }
  return `${diffStats.files} file${diffStats.files === 1 ? "" : "s"} · +${diffStats.additions} · -${diffStats.deletions}`;
}

function summarizeRichText(part: UIRichTextPart): string | undefined {
  const text = part.nodes
    .map((node) => node.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!text) {
    return undefined;
  }

  return text.length <= 80 ? text : `${text.slice(0, 77)}...`;
}