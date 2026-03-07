import type { GitDiffStats } from "./types";
import type {
  UIGitDiffPart,
  UIImagePart,
  UIMessage,
  UIPdfPart,
  UIRichTextPart,
  UITextFilePart,
} from "./ui-messages";

export type ArtifactDescriptorKind = "git-diff" | "document" | "file" | "media";

export type ArtifactDescriptorStatus = "ready";

export type ArtifactDescriptorPart =
  | UIGitDiffPart
  | UIRichTextPart
  | UIImagePart
  | UIPdfPart
  | UITextFilePart;

export type ArtifactDescriptorOrigin =
  | {
      type: "thread";
      threadId: string;
      field: "gitDiff";
    }
  | {
      type: "message-part";
      messageIndex: number;
      partIndex: number;
      messageRole: "user" | "agent";
    }
  | {
      type: "system-message";
      messageIndex: number;
      partIndex: number;
      messageType: "git-diff";
    };

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
 * optional thread-level git diff state. The descriptor keeps the source `part`
 * object (or a synthesized `UIGitDiffPart` for thread state) so renderers can
 * continue to rely on the existing message-part contract.
 */
export function getArtifactDescriptors({
  messages,
  thread,
}: {
  messages: UIMessage[];
  thread?: ArtifactDescriptorThreadInput | null;
}): ArtifactDescriptor[] {
  const descriptors: ArtifactDescriptor[] = [];

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

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (!message) {
      continue;
    }

    if (message.role === "system") {
      if (message.message_type !== "git-diff") {
        continue;
      }

      for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
        const part = message.parts[partIndex];
        if (!part) {
          continue;
        }

        descriptors.push({
          id: buildSystemGitDiffArtifactId({
            messageIndex,
            partIndex,
            timestamp: part.timestamp,
          }),
          kind: "git-diff",
          title: part.description?.trim() || "Diff checkpoint",
          status: "ready",
          part,
          origin: {
            type: "system-message",
            messageIndex,
            partIndex,
            messageType: "git-diff",
          },
          updatedAt: part.timestamp,
          summary: buildGitDiffSummary(part.diffStats),
        });
      }

      continue;
    }

    for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
      const part = message.parts[partIndex];
      if (!part || !isArtifactMessagePart(part)) {
        continue;
      }

      const descriptor = buildMessagePartArtifactDescriptor({
        message,
        messageIndex,
        part,
        partIndex,
      });
      if (descriptor) {
        descriptors.push(descriptor);
      }
    }
  }

  return descriptors;
}

function isArtifactMessagePart(
  part: Extract<UIMessage, { role: "user" | "agent" }>["parts"][number],
): part is Extract<
  ArtifactDescriptorPart,
  { type: "image" | "rich-text" | "pdf" | "text-file" }
> {
  return (
    part.type === "image" ||
    part.type === "rich-text" ||
    part.type === "pdf" ||
    part.type === "text-file"
  );
}

function buildMessagePartArtifactDescriptor({
  message,
  messageIndex,
  part,
  partIndex,
}: {
  message: Extract<UIMessage, { role: "user" | "agent" }>;
  messageIndex: number;
  part: Extract<ArtifactDescriptorPart, { type: "image" | "rich-text" | "pdf" | "text-file" }>;
  partIndex: number;
}): ArtifactDescriptor | null {
  const updatedAt = message.role === "user" ? normalizeTimestamp(message.timestamp) : undefined;

  switch (part.type) {
    case "rich-text":
      return {
        id: buildMessagePartArtifactId({
          message,
          messageIndex,
          partIndex,
          suffix: part.type,
        }),
        kind: "document",
        title: "Document",
        status: "ready",
        part,
        origin: {
          type: "message-part",
          messageIndex,
          partIndex,
          messageRole: message.role,
        },
        updatedAt,
        summary: summarizeRichText(part),
      };
    case "text-file":
      return {
        id: buildMessagePartArtifactId({
          message,
          messageIndex,
          partIndex,
          suffix: part.type,
        }),
        kind: "file",
        title: part.filename?.trim() || "Text file",
        status: "ready",
        part,
        origin: {
          type: "message-part",
          messageIndex,
          partIndex,
          messageRole: message.role,
        },
        updatedAt,
        summary: part.mime_type,
      };
    case "image":
      return {
        id: buildMessagePartArtifactId({
          message,
          messageIndex,
          partIndex,
          suffix: part.type,
        }),
        kind: "media",
        title: "Image",
        status: "ready",
        part,
        origin: {
          type: "message-part",
          messageIndex,
          partIndex,
          messageRole: message.role,
        },
        updatedAt,
      };
    case "pdf":
      return {
        id: buildMessagePartArtifactId({
          message,
          messageIndex,
          partIndex,
          suffix: part.type,
        }),
        kind: "media",
        title: part.filename?.trim() || "PDF",
        status: "ready",
        part,
        origin: {
          type: "message-part",
          messageIndex,
          partIndex,
          messageRole: message.role,
        },
        updatedAt,
      };
    default:
      return null;
  }
}

function buildThreadGitDiffArtifactId(threadId: string): string {
  return `artifact:thread:${threadId}:git-diff`;
}

function buildSystemGitDiffArtifactId({
  messageIndex,
  partIndex,
  timestamp,
}: {
  messageIndex: number;
  partIndex: number;
  timestamp?: string;
}): string {
  return timestamp
    ? `artifact:system:git-diff:${timestamp}:${partIndex}`
    : `artifact:system:git-diff:${messageIndex}:${partIndex}`;
}

function buildMessagePartArtifactId({
  message,
  messageIndex,
  partIndex,
  suffix,
}: {
  message: Extract<UIMessage, { role: "user" | "agent" }>;
  messageIndex: number;
  partIndex: number;
  suffix: string;
}): string {
  const timestamp = message.role === "user" ? normalizeTimestamp(message.timestamp) : undefined;
  return timestamp
    ? `artifact:${message.role}:${timestamp}:${partIndex}:${suffix}`
    : `artifact:${message.role}:${messageIndex}:${partIndex}:${suffix}`;
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