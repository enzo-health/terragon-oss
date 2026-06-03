"use client";

import type { DBUserMessage } from "@terragon/shared";
import { ImagePart } from "../chat/image-part";
import { PdfPart } from "../chat/pdf-part";
import { RichTextPart } from "../chat/rich-text-part";
import { TextFilePart } from "../chat/text-file-part";
import { TextPart } from "../chat/text-part";

type QueuedPart = DBUserMessage["parts"][number];

/**
 * Renders a single queued user-message part directly via the standalone part
 * renderers, replacing the legacy `ChatMessage` dispatch detour. The user-part
 * union is closed (text | image | rich-text | pdf | text-file), so the switch
 * is exhaustive and the `never` default fails the build if the union grows.
 */
export function QueuedUserPart({ part }: { part: QueuedPart }) {
  switch (part.type) {
    case "text":
      return <TextPart text={part.text} />;
    case "image":
      return <ImagePart imageUrl={part.image_url} />;
    case "rich-text":
      return <RichTextPart richTextPart={part} />;
    case "pdf":
      return <PdfPart pdfUrl={part.pdf_url} filename={part.filename} />;
    case "text-file":
      return (
        <TextFilePart
          textFileUrl={part.file_url}
          filename={part.filename}
          mimeType={part.mime_type}
        />
      );
    default: {
      const _exhaustive: never = part;
      void _exhaustive;
      return null;
    }
  }
}
