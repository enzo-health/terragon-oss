import {
  type UIGitDiffPart,
  type UIImagePart,
  type UIPart,
  type UIPdfPart,
  type UIPlanPart,
  type UIRichTextPart,
  type UIStructuredPlanPart,
  type UITextFilePart,
} from "@terragon/shared";
import {
  type ArtifactDescriptor,
  type ArtifactDescriptorOrigin,
  getArtifactDescriptors,
} from "@terragon/shared/db/artifact-descriptors";

export type ArtifactWorkspaceStatus = "ready" | "loading" | "error";

export interface ArtifactWorkspaceItemSummary {
  id: string;
  kind: ArtifactDescriptor["kind"];
  title: string;
  status: ArtifactWorkspaceStatus;
  summary?: string;
  errorMessage?: string;
  sourceLabel?: string;
  responseActionLabel?: string;
}

export interface ArtifactWorkspaceItem extends ArtifactWorkspaceItemSummary {
  descriptor: ArtifactDescriptor;
}

export type ArtifactWorkspaceComparablePart =
  | UIPart
  | UIGitDiffPart
  | UIStructuredPlanPart;

/**
 * Resolves which artifact should be the active one in the workspace.
 *
 * Returns the requested `activeArtifactId` if it is still present in the
 * `artifacts` list. Otherwise falls back to the first artifact in the list
 * (so the workspace always displays *something* when artifacts exist).
 * Returns `null` only when the list is empty.
 */
export function resolveActiveArtifactId({
  artifacts,
  activeArtifactId,
}: {
  artifacts: Array<Pick<ArtifactWorkspaceItemSummary, "id">>;
  activeArtifactId?: string | null;
}): string | null {
  if (artifacts.length === 0) {
    return null;
  }

  if (
    activeArtifactId &&
    artifacts.some((artifact) => artifact.id === activeArtifactId)
  ) {
    return activeArtifactId;
  }

  return artifacts[0]?.id ?? null;
}

/**
 * Locates the artifact descriptor that owns a given message part. Used by
 * the chat surface to "open in workspace" a part the user clicked on.
 *
 * Two-phase match:
 * 1. **Reference equality** — fast path for parts that are still the exact
 *    object instance the descriptor was built from.
 * 2. **Content equality** — fallback for cases where normalization (e.g.
 *    `normalizeToolCall`) shallow-cloned the part, breaking reference
 *    equality. Returns a content match only when exactly one artifact has
 *    the same identifying field, to avoid mis-resolving when duplicates
 *    share a URL or text body.
 *
 * Returns `null` when there are zero matches OR multiple ambiguous content
 * matches.
 */
export function findArtifactDescriptorForPart({
  artifacts,
  part,
}: {
  artifacts: Pick<ArtifactDescriptor, "id" | "part">[];
  part: ArtifactWorkspaceComparablePart;
}): Pick<ArtifactDescriptor, "id" | "part"> | null {
  // Fast path: reference equality (same object instance).
  const refMatch = artifacts.find((artifact) => artifact.part === part);
  if (refMatch) return refMatch;

  // Fallback: match by key content fields. Normalization (e.g. normalizeToolCall)
  // may shallow-clone parts, breaking reference equality.
  // Only return a match when exactly one artifact has the same content key,
  // to avoid resolving the wrong artifact when duplicates share a URL/content.
  const contentMatches = artifacts.filter((artifact) =>
    partsContentEqual(artifact.part, part),
  );
  return contentMatches.length === 1 ? contentMatches[0]! : null;
}

/** Lightweight structural comparison using the identifying field(s) per part type. */
function partsContentEqual(
  a: ArtifactWorkspaceComparablePart,
  b: ArtifactWorkspaceComparablePart,
): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "image":
      return a.image_url === (b as UIImagePart).image_url;
    case "pdf":
      return a.pdf_url === (b as UIPdfPart).pdf_url;
    case "text-file":
      return a.file_url === (b as UITextFilePart).file_url;
    case "rich-text":
      // nodes is an array — compare by reference first, then by serialized content
      return (
        a.nodes === (b as UIRichTextPart).nodes ||
        JSON.stringify(a.nodes) === JSON.stringify((b as UIRichTextPart).nodes)
      );
    case "plan":
      return (
        "planText" in a &&
        "planText" in b &&
        a.planText === (b as UIPlanPart).planText
      );
    case "plan-structured":
      return (
        JSON.stringify(a.entries) ===
        JSON.stringify((b as UIStructuredPlanPart).entries)
      );
    case "git-diff":
      return a.diff === (b as UIGitDiffPart).diff;
    default:
      return false;
  }
}

export function getArtifactWorkspaceViewState(
  artifact?: Pick<ArtifactWorkspaceItemSummary, "status"> | null,
): "empty" | "loading" | "error" | "ready" {
  if (!artifact) {
    return "empty" as const;
  }

  if (artifact.status === "loading") {
    return "loading" as const;
  }

  if (artifact.status === "error") {
    return "error" as const;
  }

  return "ready" as const;
}

export function getArtifactWorkspaceItems({
  messages,
  thread,
}: {
  messages: Parameters<typeof getArtifactDescriptors>[0]["messages"];
  thread?: Parameters<typeof getArtifactDescriptors>[0]["thread"];
}): ArtifactWorkspaceItemSummary[] {
  const descriptors = getArtifactDescriptors({ messages, thread });
  return descriptors.map((descriptor) =>
    getArtifactWorkspaceItemSummary(descriptor),
  );
}

export function getArtifactWorkspaceItemSummary(
  descriptor: ArtifactDescriptor,
): ArtifactWorkspaceItemSummary {
  const isDiffTooLarge =
    descriptor.kind === "git-diff" && descriptor.part.diff === "too-large";

  return {
    id: descriptor.id,
    kind: descriptor.kind,
    title: descriptor.title,
    status: isDiffTooLarge ? "error" : "ready",
    summary: getArtifactWorkspaceSummary(descriptor),
    errorMessage: isDiffTooLarge
      ? "This diff is too large to render in the artifact workspace."
      : undefined,
    sourceLabel: getArtifactSourceLabel(descriptor.origin),
    responseActionLabel: getArtifactResponseActionLabel(descriptor.origin),
  };
}

function getArtifactWorkspaceSummary(descriptor: ArtifactDescriptor) {
  if (descriptor.kind !== "git-diff" || descriptor.part.diff !== "too-large") {
    return descriptor.summary;
  }

  const files = descriptor.part.diffStats?.files;
  return typeof files === "number"
    ? `${files} file${files === 1 ? "" : "s"}`
    : descriptor.summary;
}

function getArtifactSourceLabel(origin: ArtifactDescriptorOrigin) {
  switch (origin.type) {
    case "thread":
      return "Current thread";
    case "user-message-part":
      return "Message attachment";
    case "tool-part":
      return "Tool output";
    case "system-message":
      return "Checkpoint";
    case "plan-tool":
      return "Agent plan";
    case "artifact-reference":
      return "Runtime artifact";
    default: {
      const exhaustiveCheck: never = origin;
      return exhaustiveCheck;
    }
  }
}

function getArtifactResponseActionLabel(origin: ArtifactDescriptorOrigin) {
  switch (origin.type) {
    case "tool-part":
      return origin.toolCallName;
    case "system-message":
      return "Git diff";
    case "thread":
      return "Working tree";
    case "user-message-part":
      return undefined;
    case "plan-tool":
      return "Plan";
    case "artifact-reference":
      return origin.artifactType;
    default: {
      const exhaustiveCheck: never = origin;
      return exhaustiveCheck;
    }
  }
}
