import { generateFileUploadUrlForUser } from "@/server-lib/r2-file-upload";
import { DBUserMessage } from "@terragon/shared";

export type UserAttachmentUploadType = "image" | "pdf" | "text-file";
type UploadableBytes = ArrayBuffer | Uint8Array | Blob | string;

async function base64ToFile(base64: string): Promise<File> {
  const blob = await fetch(base64).then((res) => res.blob());
  const mime = blob.type;
  const ext = mime.split("/")[1] || "bin";
  const binary = await blob.arrayBuffer();
  const bytes = new Uint8Array(binary);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return new File([bytes], `${hashHex}.${ext}`, { type: mime });
}

function getUploadSizeInBytes(contents: UploadableBytes) {
  if (typeof contents === "string") {
    return Buffer.byteLength(contents);
  }
  if (contents instanceof ArrayBuffer) {
    return contents.byteLength;
  }
  if (contents instanceof Blob) {
    return contents.size;
  }
  return contents.byteLength;
}

function toFetchBody(contents: UploadableBytes): BodyInit {
  if (contents instanceof ArrayBuffer) {
    return new Uint8Array(contents);
  }
  return contents;
}

export async function uploadUserAttachmentBytes({
  userId,
  fileType,
  contentType,
  contents,
  fileNamePrefix,
}: {
  userId: string;
  fileType: UserAttachmentUploadType;
  contentType: string;
  contents: UploadableBytes;
  fileNamePrefix?: string;
}): Promise<string> {
  const { presignedUrl, publicUrl } = await generateFileUploadUrlForUser({
    userId,
    fileType,
    contentType,
    sizeInBytes: getUploadSizeInBytes(contents),
    fileNamePrefix,
  });
  const uploadResponse = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: toFetchBody(contents),
  });
  if (!uploadResponse.ok) {
    throw new Error(`Upload failed: ${await uploadResponse.text()}`);
  }
  if (!publicUrl) {
    throw new Error("No public URL found");
  }
  return publicUrl;
}

async function uploadImageForUser({
  userId,
  base64Image,
}: {
  userId: string;
  base64Image: string;
}): Promise<string> {
  const file = await base64ToFile(base64Image);
  return uploadUserAttachmentBytes({
    userId,
    fileType: "image",
    contentType: file.type,
    contents: file,
  });
}

async function uploadPdfForUser({
  userId,
  base64Pdf,
}: {
  userId: string;
  base64Pdf: string;
}): Promise<string> {
  const file = await base64ToFile(base64Pdf);
  return uploadUserAttachmentBytes({
    userId,
    fileType: "pdf",
    contentType: file.type,
    contents: file,
  });
}

async function uploadTextFileForUser({
  userId,
  base64TextFile,
}: {
  userId: string;
  base64TextFile: string;
}): Promise<string> {
  const file = await base64ToFile(base64TextFile);
  return uploadUserAttachmentBytes({
    userId,
    fileType: "text-file",
    contentType: file.type,
    contents: file,
  });
}

export async function uploadUserMessageImages({
  userId,
  message,
}: {
  userId: string;
  message: DBUserMessage;
}): Promise<DBUserMessage> {
  const r2UrlByImageUrl: Record<string, string> = {};
  const r2UrlByPdfUrl: Record<string, string> = {};
  const r2UrlByTextFileUrl: Record<string, string> = {};
  const results = await Promise.allSettled(
    message.parts.map(async (part) => {
      if (part.type === "image" && part.image_url.startsWith("data:")) {
        const r2Url = await uploadImageForUser({
          userId,
          base64Image: part.image_url,
        });
        r2UrlByImageUrl[part.image_url] = r2Url;
      } else if (part.type === "pdf" && part.pdf_url.startsWith("data:")) {
        const r2Url = await uploadPdfForUser({
          userId,
          base64Pdf: part.pdf_url,
        });
        r2UrlByPdfUrl[part.pdf_url] = r2Url;
      } else if (
        part.type === "text-file" &&
        part.file_url.startsWith("data:")
      ) {
        const r2Url = await uploadTextFileForUser({
          userId,
          base64TextFile: part.file_url,
        });
        r2UrlByTextFileUrl[part.file_url] = r2Url;
      }
    }),
  );
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Failed to upload files");
  }
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === "image") {
        return {
          ...part,
          image_url: r2UrlByImageUrl[part.image_url] ?? part.image_url,
        };
      } else if (part.type === "pdf") {
        return {
          ...part,
          pdf_url: r2UrlByPdfUrl[part.pdf_url] ?? part.pdf_url,
        };
      } else if (part.type === "text-file") {
        return {
          ...part,
          file_url: r2UrlByTextFileUrl[part.file_url] ?? part.file_url,
        };
      }
      return part;
    }),
  };
}

export async function uploadClaudeSessionToR2({
  userId,
  threadId,
  sessionId,
  contents,
}: {
  userId: string;
  threadId: string;
  sessionId: string;
  contents: string;
}) {
  const { presignedUrl, r2Key } = await generateFileUploadUrlForUser({
    userId,
    fileType: "claudeSession",
    contentType: "text/plain",
    sizeInBytes: Buffer.byteLength(contents),
    fileNamePrefix: `${threadId}/${sessionId}-`,
  });
  const uploadResponse = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "text/plain" },
    body: contents,
  });
  if (!uploadResponse.ok) {
    throw new Error(`Upload failed: ${await uploadResponse.text()}`);
  }
  return r2Key;
}
