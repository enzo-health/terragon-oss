import { r2Private, r2Public } from "./r2";
import crypto from "crypto";

export type FileUploadTypeForClient = "image" | "audio" | "pdf" | "text-file";
export type FileUploadType =
  | "image"
  | "audio"
  | "pdf"
  | "text-file"
  | "claudeSession";

interface FileUploadConfig {
  type: FileUploadType;
  bucketType: "private" | "public";
  maxSize: number;
  allowedTypes: string[];
  allowedTypePrefixes?: string[];
  pathPrefix: string;
}

export function getR2ClientForFileUploadType(fileType: FileUploadType) {
  const config = UPLOAD_CONFIGS[fileType];
  if (!config) {
    throw new Error(`Invalid file type: ${fileType}`);
  }
  return config.bucketType === "public" ? r2Public : r2Private;
}

const clientSideFileUploadTypes: Record<FileUploadTypeForClient, boolean> = {
  image: true,
  audio: true,
  pdf: true,
  "text-file": true,
};

export function isClientSideFileUploadType(fileType: FileUploadType) {
  return Object.keys(clientSideFileUploadTypes).includes(fileType);
}

const UPLOAD_CONFIGS: Record<FileUploadType, FileUploadConfig> = {
  image: {
    type: "image",
    bucketType: "public",
    maxSize: 10 * 1024 * 1024, // 10MB
    allowedTypes: [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/svg+xml",
    ],
    pathPrefix: "images",
  },
  audio: {
    type: "audio",
    bucketType: "public",
    maxSize: 25 * 1024 * 1024, // 25MB
    allowedTypes: ["audio/webm"],
    pathPrefix: "audio",
  },
  pdf: {
    type: "pdf",
    bucketType: "public",
    maxSize: 25 * 1024 * 1024, // 25MB
    allowedTypes: ["application/pdf"],
    pathPrefix: "pdfs",
  },
  "text-file": {
    type: "text-file",
    bucketType: "public",
    maxSize: 10 * 1024 * 1024, // 10MB
    allowedTypePrefixes: ["text/"],
    allowedTypes: ["application/json"],
    pathPrefix: "text-files",
  },
  claudeSession: {
    type: "claudeSession",
    bucketType: "private",
    maxSize: 100 * 1024 * 1024, // 100MB
    allowedTypes: ["text/plain"],
    pathPrefix: "claude-sessions",
  },
};

function getExtensionFromContentType(contentType: string) {
  switch (contentType) {
    case "text/plain":
      return "txt";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    default:
      return contentType.split("/")[1] || "bin";
  }
}

export async function generateFileUploadUrlForUser({
  userId,
  fileType,
  contentType,
  fileNamePrefix,
  sizeInBytes,
}: {
  userId: string;
  fileType: FileUploadType;
  contentType: string;
  fileNamePrefix?: string;
  sizeInBytes: number;
}): Promise<{
  presignedUrl: string;
  r2Key: string;
  publicUrl?: string;
}> {
  const config = UPLOAD_CONFIGS[fileType];
  if (!config) {
    throw new Error(`Invalid file type: ${fileType}`);
  }
  validateFileUpload({ fileType, contentType, sizeInBytes });
  const r2Client = getR2ClientForFileUploadType(fileType);
  const timestamp = Date.now();
  const ext = getExtensionFromContentType(contentType);
  const fileName = `${config.pathPrefix}/${userId}/${fileNamePrefix ?? ""}${crypto.randomUUID()}-${timestamp}.${ext}`;
  const { presignedUrl, r2Key } = await r2Client.generatePresignedUploadUrl(
    fileName,
    contentType,
    sizeInBytes,
    { skipPrefix: true },
  );
  if (config.bucketType === "private") {
    return { presignedUrl, r2Key };
  }
  const publicUrl = r2Client.getPublicR2Url(r2Key);
  if (!publicUrl) {
    throw new Error(`Failed to get public URL for ${r2Key}`);
  }
  return { presignedUrl, r2Key, publicUrl };
}

export function validateFileUpload({
  fileType,
  contentType,
  sizeInBytes,
}: {
  fileType: FileUploadType;
  contentType: string;
  sizeInBytes: number;
}) {
  const config = UPLOAD_CONFIGS[fileType];
  if (!config) {
    throw new Error(`Invalid file type: ${fileType}`);
  }
  if (
    !config.allowedTypes.includes(contentType) &&
    !config.allowedTypePrefixes?.some((prefix) =>
      contentType.startsWith(prefix),
    )
  ) {
    throw new Error(
      `Invalid content type for ${fileType}. Allowed types: ${config.allowedTypes.join(
        ", ",
      )}, ${config.allowedTypePrefixes
        ?.map((prefix) => `${prefix}*`)
        .join(", ")}`,
    );
  }
  if (sizeInBytes > config.maxSize) {
    throw new Error(
      `File size exceeds maximum of ${config.maxSize / 1024 / 1024}MB for ${fileType}`,
    );
  }
}
