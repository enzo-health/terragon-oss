import { memo, useMemo } from "react";
import { UIPart } from "@terragon/shared";
import {
  type ArtifactDescriptor,
  extractProposedPlanText,
} from "@terragon/shared/db/artifact-descriptors";
import { ToolPartProps } from "./tool-part";
import {
  createArtifactDescriptorLookup,
  findArtifactDescriptorForPart,
  type ArtifactDescriptorLookup,
} from "./secondary-panel";
import type { UIPartExtended } from "./ui-parts-extended";
import {
  type PartRegistryContext,
  renderPartFromRegistry,
} from "./parts/part-registry";

export interface MessagePartProps {
  part: UIPart;
  onClick?: () => void;
  isLatest?: boolean;
  isAgentWorking?: boolean;
  artifactDescriptors?: ArtifactDescriptor[];
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
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
  artifactDescriptorLookup,
  onOpenArtifact,
  planOccurrenceIndex = 0,
  githubRepoFullName,
  branchName,
  baseBranchName,
  hasCheckpoint,
  toolProps,
}: MessagePartProps) {
  const fallbackArtifactDescriptorLookup = useMemo(
    () =>
      artifactDescriptorLookup ??
      createArtifactDescriptorLookup(artifactDescriptors),
    [artifactDescriptorLookup, artifactDescriptors],
  );
  const artifactDescriptor = useMemo(
    () =>
      findArtifactDescriptorForPart({
        artifacts: artifactDescriptors,
        lookup: fallbackArtifactDescriptorLookup,
        part,
      }),
    [artifactDescriptors, fallbackArtifactDescriptorLookup, part],
  );
  const handleOpenArtifact = useMemo(() => {
    if (!artifactDescriptor || !onOpenArtifact) return undefined;
    return () => {
      onOpenArtifact(artifactDescriptor.id);
    };
  }, [artifactDescriptor, onOpenArtifact]);

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
  // (rich content emitted by dbAgentPartToUIPart in Sprint 5). The stub
  // delegation variant now carries an explicit `type: "delegation-stub"`
  // discriminator (split from the previous `"delegation"`-shaped union) so
  // the registry handles it via its own entry — no more `"delegationId" in
  // extendedPart` special-case here.
  const extendedPart = part as UIPartExtended;

  const ctx: PartRegistryContext = {
    isLatest,
    isAgentWorking,
    onClick,
    toolProps,
    artifactDescriptors,
    artifactDescriptorLookup: fallbackArtifactDescriptorLookup,
    onOpenArtifact,
    artifactDescriptor,
    onOpenInArtifactWorkspace: handleOpenArtifact,
    onOpenPlanArtifact: handleOpenPlanArtifact,
    githubRepoFullName,
    branchName,
    baseBranchName,
    hasCheckpoint,
  };

  // Typed dispatch via the registry. The dispatcher lives in
  // `parts/part-registry.ts` so it can isolate the runtime → static-typing
  // bridge to a single point. Adding a new `UIPartExtended` variant without
  // a registry entry breaks compilation in `part-registry.ts` via the
  // exhaustiveness assertion there.
  return renderPartFromRegistry(ctx, extendedPart);
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
    prevProps.artifactDescriptorLookup !== nextProps.artifactDescriptorLookup ||
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

  // Per-tool memoization logic could be added here in the future.
  return true;
}
