import {
  type UIGitDiffPart,
  type UIPart,
  type UIRepoFilePart,
  type UIStructuredPlanPart,
} from "@terragon/shared";
import {
  type ArtifactDescriptor,
  type ArtifactDescriptorOrigin,
  getArtifactDescriptors,
} from "@terragon/shared/db/artifact-descriptors";

export const ARTIFACT_WORKSPACE_PANEL_ID = "artifact-workspace-panel";

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
  | UIStructuredPlanPart
  | UIRepoFilePart;

type ArtifactDescriptorMatch = Pick<ArtifactDescriptor, "id" | "part">;

export type ArtifactDescriptorLookup = {
  byReference: WeakMap<object, ArtifactDescriptorMatch>;
  byContentKey: Map<string, ArtifactDescriptorMatch | null>;
};

export function createArtifactDescriptorLookup(
  artifacts: ArtifactDescriptorMatch[],
): ArtifactDescriptorLookup {
  const byReference = new WeakMap<object, ArtifactDescriptorMatch>();
  const byContentKey = new Map<string, ArtifactDescriptorMatch | null>();

  for (const artifact of artifacts) {
    if (!byReference.has(artifact.part)) {
      byReference.set(artifact.part, artifact);
    }
    const contentKey = getPartContentKey(artifact.part);
    if (!contentKey) continue;

    if (byContentKey.has(contentKey)) {
      byContentKey.set(contentKey, null);
      continue;
    }
    byContentKey.set(contentKey, artifact);
  }

  return { byReference, byContentKey };
}

/**
 * Maps a clicked in-repo file path to the artifact that should open in the
 * workspace. The current artifact open flow keys on the working-tree git-diff
 * artifact (it renders every changed file), so a file path resolves to the
 * first `git-diff` descriptor. `filePath` is accepted so a future per-file
 * selection inside the diff view can narrow the target without changing the
 * call sites. Returns `null` when no git-diff artifact exists yet.
 */
export function resolveRepoFileArtifactId({
  artifacts,
  filePath,
}: {
  artifacts: Array<Pick<ArtifactDescriptor, "id" | "kind">>;
  filePath: string;
}): string | null {
  void filePath;
  const gitDiffArtifact = artifacts.find(
    (artifact) => artifact.kind === "git-diff",
  );
  return gitDiffArtifact?.id ?? null;
}

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
  lookup,
  part,
}: {
  artifacts: ArtifactDescriptorMatch[];
  lookup?: ArtifactDescriptorLookup;
  part: ArtifactWorkspaceComparablePart;
}): ArtifactDescriptorMatch | null {
  const artifactLookup = lookup ?? createArtifactDescriptorLookup(artifacts);

  // Fast path: reference equality (same object instance).
  const refMatch = artifactLookup.byReference.get(part);
  if (refMatch) return refMatch;

  // Fallback: match by key content fields. Normalization (e.g. normalizeToolCall)
  // may shallow-clone parts, breaking reference equality.
  // Only return a match when exactly one artifact has the same content key,
  // to avoid resolving the wrong artifact when duplicates share a URL/content.
  const contentKey = getPartContentKey(part);
  if (!contentKey) return null;
  return artifactLookup.byContentKey.get(contentKey) ?? null;
}

function getPartContentKey(
  part: ArtifactWorkspaceComparablePart,
): string | null {
  switch (part.type) {
    case "image":
      return `image:${part.image_url}`;
    case "pdf":
      return `pdf:${part.pdf_url}`;
    case "text-file":
      return `text-file:${part.file_url}`;
    case "rich-text":
      return `rich-text:${safeStableStringify(part.nodes)}`;
    case "plan":
      return "planText" in part ? `plan:${part.planText}` : null;
    case "plan-structured":
      return `plan-structured:${safeStableStringify(part.entries)}`;
    case "git-diff":
      return `git-diff:${part.diff}`;
    case "repo-file":
      return `repo-file:${part.ref ?? "working"}:${part.path}`;
    default:
      return null;
  }
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
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
    case "repo-file":
      return "Repo file";
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
    case "repo-file":
      return origin.lineRange
        ? `Lines ${origin.lineRange.start}-${origin.lineRange.end}`
        : "File";
    default: {
      const exhaustiveCheck: never = origin;
      return exhaustiveCheck;
    }
  }
}
