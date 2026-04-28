import { memo, useMemo } from "react";
import { UIPart } from "@terragon/shared";
import {
  type ArtifactDescriptor,
  extractProposedPlanText,
} from "@terragon/shared/db/artifact-descriptors";
import { ToolPartProps } from "./tool-part";
import { findArtifactDescriptorForPart } from "./secondary-panel";
import type { UIPartExtended } from "./ui-parts-extended";
import {
  PART_REGISTRY,
  type PartByType,
  type PartRegistryContext,
} from "./parts/part-registry";

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

  // Cast to the extended union so the registry sees all www-local variants
  // (rich content emitted by dbAgentPartToUIPart in Sprint 5).
  const extendedPart = part as UIPartExtended;

  // Special-case: the `delegation` registry entry assumes the canonical
  // full-payload shape (`DBDelegationMessage`). The stub variant (no
  // `delegationId`, just `{ agentName, status, message }`) renders to a
  // small inline card. The registry's author flagged this as needing a
  // follow-up; we keep the stub branch local until the renderer is widened.
  if (extendedPart.type === "delegation" && !("delegationId" in extendedPart)) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
        <div className="font-medium">Delegated to {extendedPart.agentName}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {extendedPart.status}
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm">
          {extendedPart.message}
        </p>
      </div>
    );
  }

  const ctx: PartRegistryContext = {
    isLatest,
    isAgentWorking,
    onClick,
    toolProps,
    artifactDescriptors,
    onOpenArtifact,
    artifactDescriptor,
    onOpenInArtifactWorkspace: handleOpenArtifact,
    onOpenPlanArtifact: handleOpenPlanArtifact,
    githubRepoFullName,
    branchName,
    baseBranchName,
    hasCheckpoint,
  };

  // Typed dispatch via the registry. Each entry's `buildProps` is narrowed
  // to its specific part variant; the cast through `unknown` here is the
  // single bridge between the runtime-discriminated lookup and the
  // statically-typed entry. Adding a new `UIPartExtended` variant without
  // a registry entry breaks compilation in `part-registry.ts`.
  type Key = UIPartExtended["type"];
  const key = extendedPart.type as Key;
  const entry = PART_REGISTRY[key] as {
    component: React.ComponentType<Record<string, unknown>>;
    buildProps: (
      ctx: PartRegistryContext,
      part: PartByType<Key>,
    ) => Record<string, unknown>;
  };
  const Component = entry.component;
  const props = entry.buildProps(ctx, extendedPart as PartByType<Key>);
  return <Component {...props} />;
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
    prevProps.toolProps.messagesRef !== nextProps.toolProps.messagesRef ||
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
  return toolName === "ExitPlanMode" ? true : true;
}
