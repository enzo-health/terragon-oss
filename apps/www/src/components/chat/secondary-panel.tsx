"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  DBMessage,
  ThreadInfoFull,
  type UIGitDiffPart,
  type UIImagePart,
  type UIPart,
  type UIPdfPart,
  type UIPlanPart,
  type UIRichTextPart,
  type UITextFilePart,
} from "@terragon/shared";
import {
  getArtifactDescriptors,
  type ArtifactDescriptor,
  type ArtifactDescriptorOrigin,
  type ExitPlanModeToolPart,
  type PlanArtifactDescriptor,
} from "@terragon/shared/db/artifact-descriptors";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { GitDiffView } from "./git-diff-view";
import { RichTextPart } from "./rich-text-part";
import { TextPart } from "./text-part";
import { resolvePlanText } from "./tools/plan-utils";
import { usePlatform } from "@/hooks/use-platform";
import { usePlanApproval, useSecondaryPanel } from "./hooks";
import { Button } from "@/components/ui/button";
import { Check, ExternalLink, FileDiff, X } from "lucide-react";
import type { PromptBoxRef } from "./thread-context";
import { parsePlanSpecViewModelFromText } from "@/lib/delivery-loop-plan-view-model";
import { DeliveryLoopPlanReviewCard } from "@/components/patterns/delivery-loop-plan-review-card";

const SECONDARY_PANEL_MIN_WIDTH = 300;
const SECONDARY_PANEL_MAX_WIDTH_PERCENTAGE = 0.7;
const SECONDARY_PANEL_DEFAULT_WIDTH = 0.5;
const SECONDARY_PANEL_RESIZE_STEP = 32;
const SECONDARY_PANEL_FALLBACK_CONTAINER_WIDTH = 1024;

export const ARTIFACT_WORKSPACE_PANEL_ID = "artifact-workspace-panel";
const PREVIEW_TRUNCATED_SUFFIX =
  "\n\n--- Preview truncated. Use \u201COpen raw\u201D for the full file. ---";

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

interface ArtifactWorkspaceItem extends ArtifactWorkspaceItemSummary {
  descriptor: ArtifactDescriptor;
}

type ArtifactWorkspaceComparablePart = UIPart | UIGitDiffPart;

export function resolveActiveArtifactId({
  artifacts,
  activeArtifactId,
}: {
  artifacts: Array<Pick<ArtifactWorkspaceItemSummary, "id">>;
  activeArtifactId?: string | null;
}) {
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

export function findArtifactDescriptorForPart({
  artifacts,
  part,
}: {
  artifacts: Pick<ArtifactDescriptor, "id" | "part">[];
  part: ArtifactWorkspaceComparablePart;
}) {
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
    case "git-diff":
      return a.diff === (b as UIGitDiffPart).diff;
    default:
      return false;
  }
}

export function getArtifactWorkspaceViewState(
  artifact?: Pick<ArtifactWorkspaceItemSummary, "status"> | null,
) {
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
}) {
  const descriptors = getArtifactDescriptors({ messages, thread });
  return descriptors.map((descriptor) =>
    getArtifactWorkspaceItemSummary(descriptor),
  );
}

function getArtifactWorkspaceItemSummary(
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
    default: {
      const exhaustiveCheck: never = origin;
      return exhaustiveCheck;
    }
  }
}

export function SecondaryPanel({
  thread,
  artifactDescriptors,
  activeArtifactId,
  onActiveArtifactChange,
  containerRef,
  messages = [],
  threadChatId,
  isReadOnly = false,
  promptBoxRef,
}: {
  thread: ThreadInfoFull;
  artifactDescriptors: ArtifactDescriptor[];
  activeArtifactId: string | null;
  onActiveArtifactChange: (artifactId: string | null) => void;
  containerRef: React.RefObject<HTMLElement | null>;
  messages?: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
}) {
  const platform = usePlatform();
  const {
    isSecondaryPanelOpen: isOpen,
    setIsSecondaryPanelOpen: onOpenChange,
  } = useSecondaryPanel();
  const artifacts = useMemo<ArtifactWorkspaceItem[]>(
    () =>
      artifactDescriptors.map((descriptor) => ({
        ...getArtifactWorkspaceItemSummary(descriptor),
        descriptor,
      })),
    [artifactDescriptors],
  );

  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  const { width, setWidth, isResizing, handleMouseDown } = useResizablePanel({
    minWidth: SECONDARY_PANEL_MIN_WIDTH,
    maxWidth: SECONDARY_PANEL_MAX_WIDTH_PERCENTAGE,
    defaultWidth: SECONDARY_PANEL_DEFAULT_WIDTH,
    mode: "percentage",
    direction: "rtl",
    containerRef,
    enabled: isOpen && platform === "desktop",
  });

  const getSecondaryPanelMaxWidth = () => {
    const containerWidth =
      containerRef.current?.offsetWidth ??
      (typeof window !== "undefined"
        ? window.innerWidth
        : SECONDARY_PANEL_FALLBACK_CONTAINER_WIDTH);

    return containerWidth * SECONDARY_PANEL_MAX_WIDTH_PERCENTAGE;
  };

  const clampSecondaryPanelWidth = (nextWidth: number) => {
    return Math.min(
      Math.max(nextWidth, SECONDARY_PANEL_MIN_WIDTH),
      getSecondaryPanelMaxWidth(),
    );
  };

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let nextWidth = width;

    switch (event.key) {
      case "ArrowLeft":
        nextWidth = width + SECONDARY_PANEL_RESIZE_STEP;
        break;
      case "ArrowRight":
        nextWidth = width - SECONDARY_PANEL_RESIZE_STEP;
        break;
      case "Home":
        nextWidth = SECONDARY_PANEL_MIN_WIDTH;
        break;
      case "End":
        nextWidth = getSecondaryPanelMaxWidth();
        break;
      default:
        return;
    }

    event.preventDefault();
    setWidth(clampSecondaryPanelWidth(nextWidth));
  };

  if (platform === "mobile") {
    return (
      <Drawer open={isOpen} onOpenChange={onOpenChange}>
        <DrawerContent className="h-[80vh] overflow-hidden p-0">
          <DrawerHeader className="sr-only">
            <DrawerTitle>Artifact workspace</DrawerTitle>
          </DrawerHeader>
          <SecondaryPanelContent
            artifacts={artifacts}
            activeArtifactId={activeArtifactId}
            onActiveArtifactChange={onActiveArtifactChange}
            onClose={handleClose}
            thread={thread}
            messages={messages}
            threadChatId={threadChatId}
            isReadOnly={isReadOnly}
            promptBoxRef={promptBoxRef}
          />
        </DrawerContent>
      </Drawer>
    );
  }

  if (!isOpen) return null;

  return (
    <>
      <div
        className={cn(
          "w-1.5 cursor-col-resize hover:bg-blue-500/50 transition-colors flex-shrink-0",
          isResizing && "bg-blue-500/50",
        )}
        onMouseDown={handleMouseDown}
        onKeyDown={handleResizeKeyDown}
        role="separator"
        tabIndex={0}
        aria-label="Resize artifact workspace"
        aria-controls={ARTIFACT_WORKSPACE_PANEL_ID}
        aria-orientation="vertical"
        aria-valuemin={SECONDARY_PANEL_MIN_WIDTH}
        aria-valuemax={Math.round(getSecondaryPanelMaxWidth())}
        aria-valuenow={Math.round(width)}
        aria-valuetext={`${Math.round(width)} pixels wide`}
        title="Drag or use arrow keys to resize the artifact workspace"
      />
      <div
        className="flex-shrink-0 border-l bg-background flex flex-col h-full"
        style={{ width: `${width}px` }}
      >
        <SecondaryPanelContent
          artifacts={artifacts}
          activeArtifactId={activeArtifactId}
          onActiveArtifactChange={onActiveArtifactChange}
          onClose={handleClose}
          thread={thread}
          messages={messages}
          threadChatId={threadChatId}
          isReadOnly={isReadOnly}
          promptBoxRef={promptBoxRef}
        />
      </div>
    </>
  );
}

function SecondaryPanelContent({
  artifacts,
  activeArtifactId,
  onActiveArtifactChange,
  onClose,
  thread,
  messages,
  threadChatId,
  isReadOnly,
  promptBoxRef,
}: {
  artifacts: ArtifactWorkspaceItem[];
  activeArtifactId: string | null;
  onActiveArtifactChange: (artifactId: string | null) => void;
  onClose: () => void;
  thread: ThreadInfoFull;
  messages: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
}) {
  return (
    <ArtifactWorkspaceShell
      artifacts={artifacts}
      activeArtifactId={activeArtifactId}
      onActiveArtifactChange={onActiveArtifactChange}
      onClose={onClose}
      thread={thread}
      messages={messages}
      threadChatId={threadChatId}
      isReadOnly={isReadOnly}
      promptBoxRef={promptBoxRef}
      emptyState={{
        title: "No artifacts yet",
        description:
          "Artifacts like diffs and generated outputs will appear here.",
      }}
    />
  );
}

function ArtifactWorkspaceShell({
  artifacts,
  activeArtifactId,
  onActiveArtifactChange,
  onClose,
  thread,
  messages,
  threadChatId,
  isReadOnly,
  promptBoxRef,
  emptyState,
}: {
  artifacts: ArtifactWorkspaceItem[];
  activeArtifactId: string | null;
  onActiveArtifactChange: (artifactId: string | null) => void;
  onClose?: () => void;
  thread: ThreadInfoFull;
  messages: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
  emptyState: {
    title: string;
    description: string;
  };
}) {
  const resolvedActiveArtifactId = resolveActiveArtifactId({
    artifacts,
    activeArtifactId,
  });
  const activeArtifact =
    artifacts.find((artifact) => artifact.id === resolvedActiveArtifactId) ??
    null;
  const viewState = getArtifactWorkspaceViewState(activeArtifact);
  const headerTitle = activeArtifact?.title ?? emptyState.title;
  const headerSummary = activeArtifact?.summary ?? emptyState.description;

  return (
    <div
      id={ARTIFACT_WORKSPACE_PANEL_ID}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="border-b px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold text-foreground">
                <FileDiff className="size-3" />
                Artifact workspace
              </span>
              {activeArtifact && (
                <>
                  <ArtifactWorkspaceChip>
                    {activeArtifact.kind}
                  </ArtifactWorkspaceChip>
                  {activeArtifact.sourceLabel && (
                    <ArtifactWorkspaceChip>
                      {activeArtifact.sourceLabel}
                    </ArtifactWorkspaceChip>
                  )}
                  {activeArtifact.responseActionLabel && (
                    <ArtifactWorkspaceChip>
                      {activeArtifact.responseActionLabel}
                    </ArtifactWorkspaceChip>
                  )}
                </>
              )}
            </div>
            <div className="mt-2 min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {headerTitle}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {headerSummary}
              </p>
            </div>
          </div>
          {onClose && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={onClose}
              aria-label="Close artifact workspace"
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
        {artifacts.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {artifacts.map((artifact) => {
              const isActive = artifact.id === resolvedActiveArtifactId;
              return (
                <button
                  key={artifact.id}
                  type="button"
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    isActive
                      ? "border-foreground/20 bg-muted text-foreground"
                      : "border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                  onClick={() => onActiveArtifactChange(artifact.id)}
                  aria-pressed={isActive}
                >
                  {artifact.title}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {viewState === "empty" && (
          <ArtifactWorkspaceState
            title={emptyState.title}
            description={emptyState.description}
          />
        )}

        {viewState === "loading" && (
          <ArtifactWorkspaceState
            title="Loading artifact"
            description="The selected artifact is still being prepared."
          />
        )}

        {viewState === "error" && (
          <ArtifactWorkspaceState
            title={activeArtifact?.title ?? "Artifact unavailable"}
            description={
              activeArtifact?.errorMessage ??
              "Something went wrong while preparing this artifact."
            }
          />
        )}

        {viewState === "ready" && activeArtifact && (
          <div className="h-full">
            <ActiveArtifactRenderer
              key={activeArtifact.id}
              descriptor={activeArtifact.descriptor}
              thread={thread}
              messages={messages}
              threadChatId={threadChatId}
              isReadOnly={isReadOnly}
              promptBoxRef={promptBoxRef}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactWorkspaceChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold text-foreground">
      {children}
    </span>
  );
}

function ActiveArtifactRenderer({
  descriptor,
  thread,
  messages,
  threadChatId,
  isReadOnly,
  promptBoxRef,
}: {
  descriptor: ArtifactDescriptor;
  thread: ThreadInfoFull;
  messages: DBMessage[];
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
}) {
  switch (descriptor.kind) {
    case "git-diff":
      return <GitDiffView thread={thread} diffPart={descriptor.part} />;
    case "document":
      return <DocumentArtifactRenderer richTextPart={descriptor.part} />;
    case "file":
      return <TextFileArtifactRenderer textFilePart={descriptor.part} />;
    case "media":
      return <MediaArtifactRenderer mediaPart={descriptor.part} />;
    case "plan":
      return (
        <PlanArtifactRenderer
          descriptor={descriptor as PlanArtifactDescriptor}
          messages={messages}
          threadId={thread.id}
          threadChatId={threadChatId}
          isReadOnly={isReadOnly}
          promptBoxRef={promptBoxRef}
        />
      );
    default:
      return null;
  }
}

function DocumentArtifactRenderer({
  richTextPart,
}: {
  richTextPart: UIRichTextPart;
}) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <RichTextPart richTextPart={richTextPart} />
      </div>
    </div>
  );
}

/** Read at most `maxBytes` from a fetch response body using a stream reader. */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback when ReadableStream is unavailable (e.g. mocked fetch in tests).
    const raw = await response.text();
    return raw.length > maxBytes
      ? raw.slice(0, maxBytes) + PREVIEW_TRUNCATED_SUFFIX
      : raw;
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      // Decode only the bytes within the cap.
      const excess = totalBytes - maxBytes;
      chunks.push(
        decoder.decode(value.slice(0, value.byteLength - excess), {
          stream: false,
        }),
      );
      await reader.cancel();
      return chunks.join("") + PREVIEW_TRUNCATED_SUFFIX;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  // Flush any remaining bytes from the decoder.
  chunks.push(decoder.decode());
  return chunks.join("");
}

function TextFileArtifactRenderer({
  textFilePart,
}: {
  textFilePart: UITextFilePart;
}) {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; content: string }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setState({ status: "loading" });
      try {
        const response = await fetch(textFilePart.file_url, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        // Cap preview at 512 KB to avoid memory spikes on large generated files.
        // Read via stream to enforce the cap even when content-length is absent.
        const MAX_PREVIEW_BYTES = 512 * 1024;
        const content = await readCappedText(response, MAX_PREVIEW_BYTES);
        setState({ status: "ready", content });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to load file preview.",
        });
      }
    }

    void load();

    return () => controller.abort();
  }, [textFilePart.file_url]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {textFilePart.filename || "Generated file"}
          </p>
          {textFilePart.mime_type && (
            <p className="text-xs text-muted-foreground">
              {textFilePart.mime_type}
            </p>
          )}
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a
            href={textFilePart.file_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="size-4" />
            Open raw
          </a>
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {state.status === "loading" && (
          <ArtifactWorkspaceState
            title="Loading preview"
            description="Fetching file contents for preview."
          />
        )}
        {state.status === "error" && (
          <ArtifactWorkspaceState
            title="Preview unavailable"
            description={`${state.message} You can still open the raw file.`}
          />
        )}
        {state.status === "ready" && (
          <pre className="min-h-full overflow-auto rounded-xl border bg-muted/40 p-4 text-xs leading-5 text-foreground whitespace-pre-wrap break-words font-mono">
            {state.content}
          </pre>
        )}
      </div>
    </div>
  );
}

function MediaArtifactRenderer({
  mediaPart,
}: {
  mediaPart: UIImagePart | UIPdfPart;
}) {
  if (mediaPart.type === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 p-4">
        <img
          src={mediaPart.image_url}
          alt="Artifact preview"
          className="max-h-full max-w-full rounded-xl border bg-background object-contain shadow-sm"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
        <p className="truncate text-sm font-medium">
          {mediaPart.filename || "PDF document"}
        </p>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a href={mediaPart.pdf_url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" />
            Open PDF
          </a>
        </Button>
      </div>
      <iframe
        src={mediaPart.pdf_url}
        title={mediaPart.filename || "PDF document"}
        className="min-h-0 h-full w-full"
      />
    </div>
  );
}

function PlanArtifactRenderer({
  descriptor,
  messages = [],
  threadId,
  threadChatId,
  isReadOnly = false,
  promptBoxRef,
}: {
  descriptor: PlanArtifactDescriptor;
  messages?: DBMessage[];
  threadId?: string;
  threadChatId?: string;
  isReadOnly?: boolean;
  promptBoxRef?: React.RefObject<PromptBoxRef | null>;
}) {
  const planText = useMemo(() => {
    if (descriptor.origin.type === "plan-tool") {
      const toolPart = descriptor.part as ExitPlanModeToolPart;
      return resolvePlanText({
        planParam: toolPart.parameters?.plan,
        messages,
        exitPlanModeToolId: toolPart.id,
      });
    }

    const planPart = descriptor.part as UIPlanPart;
    return planPart.planText;
  }, [descriptor, messages]);

  // For ExitPlanMode plans, extract the tool part ID for approve logic
  const toolPartId = useMemo(() => {
    if (descriptor.origin.type === "plan-tool") {
      return (descriptor.part as ExitPlanModeToolPart).id;
    }
    return undefined;
  }, [descriptor]);

  const { handleApprove, isPending, shouldShowApprove } = usePlanApproval({
    threadId,
    threadChatId,
    isReadOnly,
    promptBoxRef,
    toolPartId,
    messages,
  });

  // For delivery loop plans, try to parse as structured plan
  const deliveryLoopPlan = useMemo(() => {
    if (descriptor.origin.type !== "tool-part" || !planText) return null;
    return parsePlanSpecViewModelFromText(planText);
  }, [descriptor.origin.type, planText]);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        {deliveryLoopPlan ? (
          <DeliveryLoopPlanReviewCard plan={deliveryLoopPlan} />
        ) : (
          <div className="max-w-none font-sans prose prose-sm">
            {planText ? (
              <TextPart text={planText} />
            ) : (
              <p className="text-muted-foreground italic">
                (No plan content available)
              </p>
            )}
          </div>
        )}
        {shouldShowApprove && (
          <div className="flex gap-2 pt-4 border-t mt-4">
            <Button
              size="sm"
              onClick={handleApprove}
              className="flex items-center gap-2 font-sans"
              disabled={isPending}
            >
              <Check className="h-4 w-4" />
              Approve
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ArtifactWorkspaceState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-sm space-y-2">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
