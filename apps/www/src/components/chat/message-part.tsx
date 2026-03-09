import { memo, useMemo } from "react";
import {
  AllToolParts,
  UIPart,
  UIImagePart,
  UIPdfPart,
  UITextFilePart,
  UIRichTextPart,
  DBMessage,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { TextPart } from "./text-part";
import { ImagePart } from "./image-part";
import { PdfPart } from "./pdf-part";
import { TextFilePart } from "./text-file-part";
import { ToolPart } from "./tool-part";
import { RichTextPart } from "./rich-text-part";
import { ThinkingPart } from "./thinking-part";
import { assertNever } from "@terragon/shared/utils";
import { useThread } from "./thread-context";
import { findArtifactDescriptorForPart } from "./secondary-panel";

interface MessagePartProps {
  part: UIPart;
  onClick?: () => void;
  isLatest?: boolean;
  isAgentWorking?: boolean;
  artifactDescriptors?: ArtifactDescriptor[];
  onOpenArtifact?: (artifactId: string) => void;
}

export const MessagePart = memo(function MessagePart({
  part,
  onClick,
  isLatest = false,
  isAgentWorking = false,
  artifactDescriptors = [],
  onOpenArtifact,
}: MessagePartProps) {
  const { thread, threadChat } = useThread();
  const githubRepoFullName = thread?.githubRepoFullName;
  const branchName = thread?.branchName || undefined;
  const baseBranchName = thread?.repoBaseBranchName || undefined;

  // Check if thread has any git-diff messages (indicating a checkpoint has been made)
  const hasCheckpoint = useMemo(() => {
    if (!threadChat?.messages) return false;
    const messages = threadChat.messages as DBMessage[];
    return messages.some((msg) => msg.type === "git-diff");
  }, [threadChat?.messages]);
  const artifactDescriptor = useMemo(
    () =>
      findArtifactDescriptorForPart({ artifacts: artifactDescriptors, part }),
    [artifactDescriptors, part],
  );
  const handleOpenArtifact =
    artifactDescriptor && onOpenArtifact
      ? () => onOpenArtifact(artifactDescriptor.id)
      : undefined;

  switch (part.type) {
    case "text": {
      return (
        <TextPart
          text={part.text}
          githubRepoFullName={githubRepoFullName}
          branchName={branchName}
          baseBranchName={baseBranchName}
          hasCheckpoint={hasCheckpoint}
        />
      );
    }
    case "thinking": {
      return (
        <ThinkingPart
          thinking={part.thinking}
          isLatest={isLatest}
          isAgentWorking={isAgentWorking}
        />
      );
    }
    case "tool": {
      const toolPart = part as AllToolParts;
      return (
        <ToolPart
          toolPart={toolPart}
          artifactDescriptors={artifactDescriptors}
          onOpenArtifact={onOpenArtifact}
        />
      );
    }
    case "image": {
      const imagePart = part as UIImagePart;
      return <ImagePart imageUrl={imagePart.image_url} onClick={onClick} />;
    }
    case "rich-text": {
      const richTextPart = part as UIRichTextPart;
      return (
        <RichTextPart
          richTextPart={richTextPart}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />
      );
    }
    case "pdf": {
      const pdfPart = part as UIPdfPart;
      return <PdfPart pdfUrl={pdfPart.pdf_url} filename={pdfPart.filename} />;
    }
    case "text-file": {
      const textFilePart = part as UITextFilePart;
      return (
        <TextFilePart
          textFileUrl={textFilePart.file_url}
          filename={textFilePart.filename}
          mimeType={textFilePart.mime_type}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />
      );
    }
    default:
      assertNever(part);
  }
});
