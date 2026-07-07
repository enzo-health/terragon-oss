import { uploadUserAttachmentBytes } from "@/lib/r2-file-upload-server";
import { getFileTypeFromMimeTypeOrNull } from "@/lib/attachment-types";
import { validateFileUpload } from "@/server-lib/r2-file-upload";
import type { DBUserMessage } from "@terragon/shared";

export interface SlackFileLike {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
}

export interface SlackFileSkip {
  fileName: string;
  reason: "unsupported-type" | "missing-url" | "download-failed";
}

export interface SlackFileConversionResult {
  parts: DBUserMessage["parts"];
  skipped: SlackFileSkip[];
}

const MAX_SLACK_FILES_PER_MESSAGE = 5;
const MAX_FILE_NAME_LENGTH = 120;

function isSlackFileLike(value: unknown): value is SlackFileLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const file = value as SlackFileLike;
  return (
    typeof file.url_private === "string" ||
    typeof file.url_private_download === "string" ||
    typeof file.mimetype === "string" ||
    typeof file.name === "string"
  );
}

function fileNameFor(file: SlackFileLike) {
  const rawName = file.name || file.title || file.id || "slack-file";
  const cleaned = rawName
    .replace(/[/\\]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return (cleaned || "slack-file").slice(0, MAX_FILE_NAME_LENGTH);
}

async function downloadSlackFile({
  file,
  botToken,
}: {
  file: SlackFileLike;
  botToken: string;
}) {
  const url = file.url_private_download || file.url_private;
  if (!url) {
    return null;
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Slack file download failed: ${response.status}`);
  }
  return await response.arrayBuffer();
}

function validateSlackFileUploadMetadata({
  fileType,
  mimeType,
  size,
}: {
  fileType: NonNullable<ReturnType<typeof getFileTypeFromMimeTypeOrNull>>;
  mimeType: string;
  size?: number;
}) {
  if (typeof size === "number") {
    validateFileUpload({ fileType, contentType: mimeType, sizeInBytes: size });
  } else {
    validateFileUpload({ fileType, contentType: mimeType, sizeInBytes: 0 });
  }
}

function isUploadPolicyError(error: unknown) {
  return (
    error instanceof Error &&
    /^Invalid content type|^File size exceeds/.test(error.message)
  );
}

function messagePartForUploadedSlackFile({
  fileType,
  mimeType,
  url,
  fileName,
}: {
  fileType: NonNullable<ReturnType<typeof getFileTypeFromMimeTypeOrNull>>;
  mimeType: string;
  url: string;
  fileName: string;
}): DBUserMessage["parts"][number] {
  if (fileType === "image") {
    return {
      type: "image",
      mime_type: mimeType,
      image_url: url,
    };
  }
  if (fileType === "pdf") {
    return {
      type: "pdf",
      mime_type: mimeType,
      pdf_url: url,
      filename: fileName,
    };
  }
  return {
    type: "text-file",
    mime_type: mimeType,
    file_url: url,
    filename: fileName,
  };
}

export async function convertSlackFilesToMessageParts({
  files,
  botToken,
  userId,
}: {
  files: unknown[] | undefined;
  botToken: string;
  userId: string;
}): Promise<SlackFileConversionResult> {
  if (!files?.length) {
    return { parts: [], skipped: [] };
  }

  const skipped: SlackFileSkip[] = [];
  const parts: DBUserMessage["parts"] = [];

  for (const rawFile of files.slice(0, MAX_SLACK_FILES_PER_MESSAGE)) {
    if (!isSlackFileLike(rawFile)) {
      skipped.push({ fileName: "slack-file", reason: "unsupported-type" });
      continue;
    }

    const fileName = fileNameFor(rawFile);
    const mimeType = rawFile.mimetype ?? "application/octet-stream";
    const fileType = getFileTypeFromMimeTypeOrNull(mimeType);
    if (!fileType) {
      skipped.push({ fileName, reason: "unsupported-type" });
      continue;
    }

    try {
      validateSlackFileUploadMetadata({
        fileType,
        mimeType,
        size: rawFile.size,
      });
    } catch (error) {
      if (!isUploadPolicyError(error)) {
        console.warn("[slack files] Failed to validate Slack file metadata", {
          fileId: rawFile.id,
          fileName,
          error,
        });
      }
      skipped.push({ fileName, reason: "unsupported-type" });
      continue;
    }

    try {
      const bytes = await downloadSlackFile({ file: rawFile, botToken });
      if (!bytes) {
        skipped.push({ fileName, reason: "missing-url" });
        continue;
      }
      const responseMimeType = rawFile.mimetype ?? mimeType;
      const uploadedUrl = await uploadUserAttachmentBytes({
        userId,
        fileType,
        contentType: responseMimeType,
        contents: bytes,
      });
      parts.push(
        messagePartForUploadedSlackFile({
          fileType,
          mimeType: responseMimeType,
          url: uploadedUrl,
          fileName,
        }),
      );
    } catch (error) {
      if (isUploadPolicyError(error)) {
        skipped.push({ fileName, reason: "unsupported-type" });
        continue;
      }
      console.warn("[slack files] Failed to attach Slack file", {
        fileId: rawFile.id,
        fileName,
        error,
      });
      skipped.push({ fileName, reason: "download-failed" });
    }
  }
  for (const rawFile of files.slice(MAX_SLACK_FILES_PER_MESSAGE)) {
    const fileName = isSlackFileLike(rawFile)
      ? fileNameFor(rawFile)
      : "slack-file";
    skipped.push({ fileName, reason: "unsupported-type" });
  }

  return { parts, skipped };
}

export function formatSlackFileConversionNote({
  attachedCount,
  skipped,
}: SlackFileConversionResult & { attachedCount?: number }) {
  const count = attachedCount ?? 0;
  const notes: string[] = [];
  if (count > 0) {
    notes.push(`Included ${count} Slack attachment${count === 1 ? "" : "s"}.`);
  }
  if (skipped.length > 0) {
    const names = skipped.map((file) => file.fileName).join(", ");
    notes.push(
      `Skipped unsupported or unavailable Slack file${skipped.length === 1 ? "" : "s"}: ${names}.`,
    );
  }
  return notes.join("\n");
}
