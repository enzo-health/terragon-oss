"use client";

import type { AIAgent } from "@terragon/agent/types";
import {
  type ArtifactDescriptor,
  extractProposedPlanText,
} from "@terragon/shared/db/artifact-descriptors";
import { memo, useMemo } from "react";
import {
  type PartRegistryContext,
  renderPartFromRegistry,
} from "../parts/part-registry";
import { findArtifactDescriptorForPart } from "../secondary-panel";
import type { ArtifactWorkspaceComparablePart } from "../secondary-panel-helpers";
import type { UIPartExtended } from "../ui-parts-extended";
import {
  runtimePartToTerragonPart,
  type RuntimeMessagePartState,
} from "./runtime-part-conversion";
import type { TerragonThreadContext } from "./thread-context";

type RuntimePartRendererProps = {
  part: RuntimeMessagePartState;
  agent: AIAgent;
  isLatest: boolean;
  isAgentWorking: boolean;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: TerragonThreadContext["onOpenArtifact"];
  messagePartProps: TerragonThreadContext["messagePartProps"];
  planOccurrenceIndex?: number;
};

type RuntimeArtifactComparablePart = Extract<
  ArtifactWorkspaceComparablePart,
  UIPartExtended
>;

function isArtifactComparablePart(
  part: UIPartExtended,
): part is RuntimeArtifactComparablePart {
  return (
    part.type === "text" ||
    part.type === "thinking" ||
    part.type === "tool" ||
    part.type === "image" ||
    part.type === "rich-text" ||
    part.type === "pdf" ||
    part.type === "text-file" ||
    part.type === "plan" ||
    part.type === "plan-structured"
  );
}

export const RuntimePartRenderer = memo(function RuntimePartRenderer({
  part,
  agent,
  isLatest,
  isAgentWorking,
  artifactDescriptors,
  onOpenArtifact,
  messagePartProps,
  planOccurrenceIndex,
}: RuntimePartRendererProps) {
  const terragonPart = runtimePartToTerragonPart(part, agent);
  const artifactDescriptor = useMemo(() => {
    if (!terragonPart || !isArtifactComparablePart(terragonPart)) return null;
    return findArtifactDescriptorForPart({
      artifacts: artifactDescriptors,
      part: terragonPart,
    });
  }, [artifactDescriptors, terragonPart]);

  const handleOpenArtifact = useMemo(() => {
    if (!artifactDescriptor) return undefined;
    return () => onOpenArtifact(artifactDescriptor.id);
  }, [artifactDescriptor, onOpenArtifact]);

  const planArtifactDescriptor = useMemo(() => {
    if (terragonPart?.type !== "text") return null;
    const planText = extractProposedPlanText(terragonPart.text);
    if (!planText) return null;
    const exactMatch = artifactDescriptors.find(
      (descriptor) =>
        descriptor.kind === "plan" &&
        descriptor.origin.type === "tool-part" &&
        descriptor.origin.toolCallName === "proposed_plan" &&
        descriptor.origin.artifactOrdinal === (planOccurrenceIndex ?? 0) &&
        "planText" in descriptor.part &&
        descriptor.part.planText === planText,
    );
    if (exactMatch) return exactMatch;
    return (
      artifactDescriptors.find(
        (descriptor) =>
          descriptor.kind === "plan" &&
          descriptor.origin.type === "tool-part" &&
          descriptor.origin.toolCallName === "proposed_plan" &&
          "planText" in descriptor.part &&
          descriptor.part.planText === planText,
      ) ?? null
    );
  }, [artifactDescriptors, planOccurrenceIndex, terragonPart]);

  const handleOpenPlanArtifact = useMemo(() => {
    if (!planArtifactDescriptor) return undefined;
    return () => onOpenArtifact(planArtifactDescriptor.id);
  }, [onOpenArtifact, planArtifactDescriptor]);

  if (!terragonPart) {
    if (part.type === "tool-call") return part.toolUI;
    if (part.type === "data") return part.dataRendererUI;
    return null;
  }

  const registryContext: PartRegistryContext = {
    isLatest,
    isAgentWorking,
    toolProps: messagePartProps.toolProps,
    artifactDescriptors,
    onOpenArtifact,
    artifactDescriptor,
    onOpenInArtifactWorkspace: handleOpenArtifact,
    onOpenPlanArtifact: handleOpenPlanArtifact,
    githubRepoFullName: messagePartProps.githubRepoFullName,
    branchName: messagePartProps.branchName,
    baseBranchName: messagePartProps.baseBranchName,
    hasCheckpoint: messagePartProps.hasCheckpoint,
  };

  return renderPartFromRegistry(registryContext, terragonPart);
});
