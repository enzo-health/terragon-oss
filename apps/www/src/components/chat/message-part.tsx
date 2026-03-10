import { memo } from "react";
import {
  AllToolParts,
  UIPart,
  UIImagePart,
  UIPdfPart,
  UITextFilePart,
  UIRichTextPart,
} from "@terragon/shared";
import { TextPart } from "./text-part";
import { ImagePart } from "./image-part";
import { PdfPart } from "./pdf-part";
import { TextFilePart } from "./text-file-part";
import { ToolPart, ToolPartProps } from "./tool-part";
import { RichTextPart } from "./rich-text-part";
import { ThinkingPart } from "./thinking-part";
import { assertNever } from "@terragon/shared/utils";

export interface MessagePartProps {
  part: UIPart;
  onClick?: () => void;
  isLatest?: boolean;
  isAgentWorking?: boolean;
  githubRepoFullName: string;
  branchName: string | null;
  baseBranchName: string;
  hasCheckpoint: boolean;
  toolProps: Omit<ToolPartProps, "toolPart">;
}

export const MessagePart = memo(function MessagePart({
  part,
  onClick,
  isLatest = false,
  isAgentWorking = false,
  githubRepoFullName,
  branchName,
  baseBranchName,
  hasCheckpoint,
  toolProps,
}: MessagePartProps) {
  switch (part.type) {
    case "text": {
      return (
        <TextPart
          text={part.text}
          githubRepoFullName={githubRepoFullName}
          branchName={branchName ?? undefined}
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
      return <ToolPart toolPart={toolPart} {...toolProps} />;
    }
    case "image": {
      const imagePart = part as UIImagePart;
      return <ImagePart imageUrl={imagePart.image_url} onClick={onClick} />;
    }
    case "rich-text": {
      const richTextPart = part as UIRichTextPart;
      return <RichTextPart richTextPart={richTextPart} />;
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
        />
      );
    }
    default:
      assertNever(part);
  }
}, areMessagePartPropsEqual);

function areMessagePartPropsEqual(
  prevProps: MessagePartProps,
  nextProps: MessagePartProps,
) {
  if (
    prevProps.part !== nextProps.part ||
    prevProps.onClick !== nextProps.onClick ||
    prevProps.isLatest !== nextProps.isLatest ||
    prevProps.isAgentWorking !== nextProps.isAgentWorking ||
    prevProps.githubRepoFullName !== nextProps.githubRepoFullName ||
    prevProps.branchName !== nextProps.branchName ||
    prevProps.baseBranchName !== nextProps.baseBranchName ||
    prevProps.hasCheckpoint !== nextProps.hasCheckpoint
  ) {
    return false;
  }

  const prevToolPart = prevProps.part.type === "tool" ? prevProps.part : null;
  const nextToolPart = nextProps.part.type === "tool" ? nextProps.part : null;
  if (!prevToolPart || !nextToolPart) {
    return true;
  }

  if (
    prevProps.toolProps.threadId !== nextProps.toolProps.threadId ||
    prevProps.toolProps.threadChatId !== nextProps.toolProps.threadChatId ||
    prevProps.toolProps.isReadOnly !== nextProps.toolProps.isReadOnly ||
    prevProps.toolProps.promptBoxRef !== nextProps.toolProps.promptBoxRef ||
    prevProps.toolProps.childThreads !== nextProps.toolProps.childThreads ||
    prevProps.toolProps.githubRepoFullName !==
      nextProps.toolProps.githubRepoFullName ||
    prevProps.toolProps.repoBaseBranchName !==
      nextProps.toolProps.repoBaseBranchName ||
    prevProps.toolProps.branchName !== nextProps.toolProps.branchName
  ) {
    return false;
  }

  const toolName = prevToolPart.name;
  return toolName === "ExitPlanMode"
    ? prevProps.toolProps.messages === nextProps.toolProps.messages
    : true;
}
