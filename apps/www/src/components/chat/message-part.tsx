import { memo, useMemo } from "react";
import {
  AllToolParts,
  UIPart,
  UIImagePart,
  UIPdfPart,
  UITextFilePart,
  UIRichTextPart,
} from "@terragon/shared";
import {
  type ArtifactDescriptor,
  extractProposedPlanText,
} from "@terragon/shared/db/artifact-descriptors";
import { TextPart } from "./text-part";
import { ImagePart } from "./image-part";
import { PdfPart } from "./pdf-part";
import { TextFilePart } from "./text-file-part";
import { ToolPart, ToolPartProps } from "./tool-part";
import { RichTextPart } from "./rich-text-part";
import { ThinkingPart } from "./thinking-part";
import { assertNever } from "@terragon/shared/utils";
import { findArtifactDescriptorForPart } from "./secondary-panel";
import type { UIPartExtended } from "./ui-parts-extended";
import { AudioPartView } from "./audio-part-view";
import { ResourceLinkView } from "./resource-link-view";
import { TerminalPartView } from "./terminal-part-view";
import { DiffPartView } from "./diff-part";
import { AutoApprovalReviewCard } from "./auto-approval-review-card";
import { PlanPartView } from "./plan-part";
import { ServerToolUseView } from "./server-tool-use-view";
import { WebSearchResultView } from "./web-search-result-view";
import { DelegationItemCard } from "./delegation-item-card";

export interface MessagePartProps {
  part: UIPart;
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

  // Cast to extended union so the switch can handle rich part types emitted
  // by dbAgentPartToUIPart in Sprint 5. The extra cases are www-local.
  const extendedPart = part as UIPartExtended;

  switch (extendedPart.type) {
    case "text": {
      return (
        <TextPart
          text={extendedPart.text}
          streaming={isLatest && isAgentWorking}
          githubRepoFullName={githubRepoFullName}
          branchName={branchName ?? undefined}
          baseBranchName={baseBranchName}
          hasCheckpoint={hasCheckpoint}
          onOpenInArtifactWorkspace={handleOpenPlanArtifact}
        />
      );
    }
    case "thinking": {
      return (
        <ThinkingPart
          thinking={extendedPart.thinking}
          isLatest={isLatest}
          isAgentWorking={isAgentWorking}
        />
      );
    }
    case "tool": {
      const toolPart = extendedPart as AllToolParts;
      return (
        <ToolPart
          toolPart={toolPart}
          {...toolProps}
          artifactDescriptors={artifactDescriptors}
          onOpenArtifact={onOpenArtifact}
        />
      );
    }
    case "image": {
      const imagePart = extendedPart as UIImagePart;
      return (
        <ImagePart
          imageUrl={imagePart.image_url}
          onClick={onClick}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />
      );
    }
    case "rich-text": {
      const richTextPart = extendedPart as UIRichTextPart;
      return (
        <RichTextPart
          richTextPart={richTextPart}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />
      );
    }
    case "pdf": {
      const pdfPart = extendedPart as UIPdfPart;
      return (
        <PdfPart
          pdfUrl={pdfPart.pdf_url}
          filename={pdfPart.filename}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />
      );
    }
    case "text-file": {
      const textFilePart = extendedPart as UITextFilePart;
      return (
        <TextFilePart
          textFileUrl={textFilePart.file_url}
          filename={textFilePart.filename}
          mimeType={textFilePart.mime_type}
          onOpenInArtifactWorkspace={handleOpenArtifact}
        />
      );
    }
    case "plan":
      // Plan parts are rendered via the artifact workspace panel, not inline
      return null;
    // --- Extended rich content types (Sprint 5, www-local) ---
    case "audio":
      return <AudioPartView part={extendedPart} />;
    case "resource-link":
      return <ResourceLinkView part={extendedPart} />;
    case "terminal":
      return <TerminalPartView part={extendedPart} />;
    case "diff":
      return <DiffPartView part={extendedPart} />;
    case "auto-approval-review":
      return <AutoApprovalReviewCard part={extendedPart} />;
    case "plan-structured":
      return (
        <PlanPartView part={{ type: "plan", entries: extendedPart.entries }} />
      );
    case "server-tool-use":
      return <ServerToolUseView part={extendedPart} />;
    case "web-search-result":
      return <WebSearchResultView part={extendedPart} />;
    case "delegation":
      if ("delegationId" in extendedPart) {
        return <DelegationItemCard delegation={extendedPart} />;
      }
      return (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
          <div className="font-medium">
            Delegated to {extendedPart.agentName}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {extendedPart.status}
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm">
            {extendedPart.message}
          </p>
        </div>
      );
    default:
      // TypeScript exhaustiveness check — will error at compile time if a
      // UIPartExtended variant is added without a corresponding case above.
      assertNever(extendedPart);
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
    prevProps.toolProps.branchName !== nextProps.toolProps.branchName ||
    prevProps.toolProps.onOptimisticPermissionModeUpdate !==
      nextProps.toolProps.onOptimisticPermissionModeUpdate
  ) {
    return false;
  }

  const toolName = prevToolPart.name;
  return toolName === "ExitPlanMode"
    ? prevProps.toolProps.messages === nextProps.toolProps.messages
    : true;
}
