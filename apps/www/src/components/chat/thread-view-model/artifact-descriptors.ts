import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { UIMessage } from "@terragon/shared";
import {
  type ArtifactDescriptor,
  buildRepoFileArtifactId,
  createRepoFileArtifactDescriptor,
} from "@terragon/shared/db/artifact-descriptors";
import type { RepoFileLineRange } from "@terragon/shared/utils/repo-file-link";
import { getArtifactDescriptorsForMessages } from "./snapshot-adapter";
import { getObjectField, getStringField } from "./renderable-part-shape";
import type { ThreadViewModelState } from "./types";

export function getStableArtifactsForMessages({
  previous,
  messages,
  artifactThread,
}: {
  previous: ThreadViewModelState["artifacts"];
  messages: UIMessage[];
  artifactThread: ThreadViewModelState["artifactThread"];
}): ThreadViewModelState["artifacts"] {
  const preservedReferenceDescriptors = previous.descriptors.filter(
    isClientSynthesizedDescriptor,
  );
  const next = {
    descriptors: mergeArtifactDescriptors([
      ...preservedReferenceDescriptors,
      ...getArtifactDescriptorsForMessages({
        messages,
        artifactThread,
      }),
    ]),
  };
  return areArtifactDescriptorsStable(previous.descriptors, next.descriptors)
    ? previous
    : next;
}

export function preserveArtifactReferenceDescriptors(
  current: ThreadViewModelState["artifacts"],
  snapshot: ThreadViewModelState["artifacts"],
): ThreadViewModelState["artifacts"] {
  const referenceDescriptors = current.descriptors.filter(
    isClientSynthesizedDescriptor,
  );
  if (referenceDescriptors.length === 0) {
    return snapshot;
  }
  const descriptors = mergeArtifactDescriptors([
    ...referenceDescriptors,
    ...snapshot.descriptors,
  ]);
  return areArtifactDescriptorsStable(current.descriptors, descriptors)
    ? current
    : { descriptors };
}

export function upsertArtifactReferenceDescriptor(
  artifacts: ThreadViewModelState["artifacts"],
  descriptor: ArtifactDescriptor | null,
): ThreadViewModelState["artifacts"] {
  if (!descriptor) {
    return artifacts;
  }
  const nextDescriptors = mergeArtifactDescriptors([
    descriptor,
    ...artifacts.descriptors,
  ]);
  return areArtifactDescriptorsStable(artifacts.descriptors, nextDescriptors)
    ? artifacts
    : { descriptors: nextDescriptors };
}

/**
 * Reducer-owned upsert for a click-opened in-repo file preview. Mirrors
 * `upsertArtifactReferenceDescriptor`: synthesizes the descriptor from the
 * classified path/ref/lineRange and dedupes by the deterministic artifact id
 * (normalized path + ref) so reopening the same file reuses the descriptor
 * rather than creating a duplicate. Returns the existing artifacts reference
 * unchanged when the descriptor already exists.
 */
export function upsertRepoFileDescriptor(
  artifacts: ThreadViewModelState["artifacts"],
  input: { path: string; ref?: string; lineRange?: RepoFileLineRange },
): ThreadViewModelState["artifacts"] {
  const id = buildRepoFileArtifactId({ path: input.path, ref: input.ref });
  if (artifacts.descriptors.some((descriptor) => descriptor.id === id)) {
    return artifacts;
  }
  return upsertArtifactReferenceDescriptor(
    artifacts,
    createRepoFileArtifactDescriptor(input),
  );
}

/**
 * Descriptors synthesized client-side (never message-derived) must survive
 * snapshot rebuilds, since they have no source in the rehydrated transcript.
 */
function isClientSynthesizedDescriptor(
  descriptor: ArtifactDescriptor,
): boolean {
  return (
    descriptor.origin.type === "artifact-reference" ||
    descriptor.origin.type === "repo-file"
  );
}

function mergeArtifactDescriptors(
  descriptors: ArtifactDescriptor[],
): ArtifactDescriptor[] {
  const seen = new Set<string>();
  const next: ArtifactDescriptor[] = [];
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.id)) {
      continue;
    }
    seen.add(descriptor.id);
    next.push(descriptor);
  }
  return next;
}

export function getArtifactReferenceDescriptor(
  event: BaseEvent,
): ArtifactDescriptor | null {
  if (event.type !== EventType.CUSTOM) {
    return null;
  }
  const name = getStringField(event, "name");
  if (name !== "artifact-reference") {
    return null;
  }
  const value = getObjectField(event, "value");
  const artifactId = getStringField(value, "artifactId");
  const artifactType = getStringField(value, "artifactType");
  const title = getStringField(value, "title");
  const status = getStringField(value, "status");
  if (
    !artifactId ||
    artifactType !== "plan" ||
    !title ||
    (status !== null && status !== "ready")
  ) {
    return null;
  }
  const uri = getStringField(value, "uri");
  return {
    id: `artifact:reference:${artifactId}`,
    kind: "plan",
    title,
    status: "ready",
    part: {
      type: "plan",
      title,
      planText: uri ? `${title}\n\n${uri}` : title,
    },
    origin: {
      type: "artifact-reference",
      artifactId,
      artifactType,
      uri,
      fingerprint: artifactId,
    },
    summary: uri ?? undefined,
  };
}

function areArtifactDescriptorsStable(
  previous: ThreadViewModelState["artifacts"]["descriptors"],
  next: ThreadViewModelState["artifacts"]["descriptors"],
): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < previous.length; index += 1) {
    const left = previous[index]!;
    const right = next[index]!;
    if (
      left.id !== right.id ||
      left.kind !== right.kind ||
      left.status !== right.status ||
      left.title !== right.title ||
      left.updatedAt !== right.updatedAt ||
      left.summary !== right.summary ||
      getArtifactDescriptorStableValue(left.origin) !==
        getArtifactDescriptorStableValue(right.origin) ||
      getArtifactDescriptorStableValue(left.part) !==
        getArtifactDescriptorStableValue(right.part)
    ) {
      return false;
    }
  }
  return true;
}

function getArtifactDescriptorStableValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return value;
  if (typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => getArtifactDescriptorStableValue(entry)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${getArtifactDescriptorStableValue(entry)}`,
    )
    .join(",")}}`;
}
