import { memo, type ReactNode, useMemo } from "react";
import {
  AllToolParts,
  UIPart,
  UIImagePart,
  UIPdfPart,
  UITextFilePart,
  UIRichTextPart,
} from "@leo/shared";
import {
  type ArtifactDescriptor,
  extractProposedPlanText,
} from "@leo/shared/db/artifact-descriptors";
import { TextPart } from "./text-part";
import { ImagePart } from "./image-part";
import { PdfPart } from "./pdf-part";
import { TextFilePart } from "./text-file-part";
import { ToolPart, ToolPartProps } from "./tool-part";
import { RichTextPart } from "./rich-text-part";
import { ThinkingPart } from "./thinking-part";
import { assertNever } from "@leo/shared/utils";
import { findArtifactDescriptorForPart } from "./secondary-panel";
import { MessagePart as AIMessagePart } from "@/components/ai-elements/message";

export interface MessagePartProps {
  part: UIPart;
  useAiElementsLayout?: boolean;
  onClick?: () => void;
  isLatest?: boolean;
  isAgentWorking?: boolean;
  artifactDescriptors?: ArtifactDescriptor[];
  onOpenArtifact?: (artifactId: string) => void;
  /** When multiple text parts contain `<proposed_plan>` with identical content,
   *  this ordinal (0-based) disambiguates which plan descriptor to open. */
  planOccurrenceIndex?: number;
  githubRepoFullName: string;
  branchName: string | null;
  baseBranchName: string;
  hasCheckpoint: boolean;
  toolProps: Omit<ToolPartProps, "toolPart">;
}

export const MessagePart = memo(function MessagePart({
  part,
  useAiElementsLayout = false,
  onClick,
  isLatest = false,
  isAgentWorking = false,
  artifactDescriptors = [],
  onOpenArtifact,
  planOccurrenceIndex = 0,
  githubRepoFullName,
  branchName,
  baseBranchName,
  hasCheckpoint,
  toolProps,
}: MessagePartProps) {
  const artifactDescriptor = useMemo(
    () =>
      findArtifactDescriptorForPart({ artifacts: artifactDescriptors, part }),
    [artifactDescriptors, part],
  );
  const handleOpenArtifact =
    artifactDescriptor && onOpenArtifact
      ? () => onOpenArtifact(artifactDescriptor.id)
      : undefined;

  // Find the plan artifact descriptor matching this specific text part's plan content.
  // When multiple parts have identical plan text across messages,
  // planOccurrenceIndex + artifactOrdinal disambiguate.
  const planArtifactDescriptor = useMemo(() => {
    if (part.type !== "text") return null;
    const planText = extractProposedPlanText(part.text);
    if (!planText) return null;
    // First try exact match by occurrence index (stored as artifactOrdinal)
    const exactMatch = artifactDescriptors.find(
      (d) =>
        d.kind === "plan" &&
        d.origin.type === "tool-part" &&
        d.origin.toolCallName === "proposed_plan" &&
        d.origin.artifactOrdinal === planOccurrenceIndex &&
        "planText" in d.part &&
        d.part.planText === planText,
    );
    if (exactMatch) return exactMatch;
    // Fallback: first descriptor with matching plan text
    return (
      artifactDescriptors.find(
        (d) =>
          d.kind === "plan" &&
          d.origin.type === "tool-part" &&
          d.origin.toolCallName === "proposed_plan" &&
          "planText" in d.part &&
          d.part.planText === planText,
      ) ?? null
    );
  }, [part, artifactDescriptors, planOccurrenceIndex]);

  const handleOpenPlanArtifact = useMemo(() => {
    if (!planArtifactDescriptor || !onOpenArtifact) return undefined;
    return () => {
      onOpenArtifact(planArtifactDescriptor.id);
    };
  }, [planArtifactDescriptor, onOpenArtifact]);

  const wrapPart = (node: ReactNode): ReactNode => {
    if (!useAiElementsLayout) {
      return node;
    }
    return <AIMessagePart>{node}</AIMessagePart>;
  };

  switch (part.type) {
    case "text": {
      return wrapPart(
        <TextPart
          text={part.text}
          streaming={isLatest && isAgentWorking}
          githubRepoFullName={githubRepoFullName}
          branchName={branchName ?? undefined}
          baseBranchName={baseBranchName}
          hasCheckpoint={hasCheckpoint}
          onOpenInArtifactWorkspace={handleOpenPlanArtifact}
        />,
      );
    }
    case "thinking": {
      return wrapPart(
        <ThinkingPart
          thinking={part.thinking}
          isLatest={isLatest}
          isAgentWorking={isAgentWorking}
        />,
      );
    }
    case "tool": {
      const toolPart = part as AllToolParts;
      return wrapPart(
        <ToolPart
          toolPart={toolPart}
          {...toolProps}
          artifactDescriptors={artifactDescriptors}
          onOpenArtifact={onOpenArtifact}
        />,
      );
    }
    case "image": {
      const imagePart = part as UIImagePart;
      return wrapPart(
        <ImagePart
          imageUrl={imagePart.image_url}
          onClick={onClick}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />,
      );
    }
    case "rich-text": {
      const richTextPart = part as UIRichTextPart;
      return wrapPart(
        <RichTextPart
          richTextPart={richTextPart}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />,
      );
    }
    case "pdf": {
      const pdfPart = part as UIPdfPart;
      return wrapPart(
        <PdfPart
          pdfUrl={pdfPart.pdf_url}
          filename={pdfPart.filename}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />,
      );
    }
    case "text-file": {
      const textFilePart = part as UITextFilePart;
      return wrapPart(
        <TextFilePart
          textFileUrl={textFilePart.file_url}
          filename={textFilePart.filename}
          mimeType={textFilePart.mime_type}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />,
      );
    }
    case "plan":
      // Plan parts are rendered via the artifact workspace panel, not inline
      return null;
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
    prevProps.useAiElementsLayout !== nextProps.useAiElementsLayout ||
    prevProps.onClick !== nextProps.onClick ||
    prevProps.isLatest !== nextProps.isLatest ||
    prevProps.isAgentWorking !== nextProps.isAgentWorking ||
    prevProps.githubRepoFullName !== nextProps.githubRepoFullName ||
    prevProps.branchName !== nextProps.branchName ||
    prevProps.baseBranchName !== nextProps.baseBranchName ||
    prevProps.hasCheckpoint !== nextProps.hasCheckpoint ||
    prevProps.artifactDescriptors !== nextProps.artifactDescriptors ||
    prevProps.onOpenArtifact !== nextProps.onOpenArtifact ||
    prevProps.planOccurrenceIndex !== nextProps.planOccurrenceIndex
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
