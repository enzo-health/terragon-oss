import { ThreadInfoFull } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { UIGitDiffPart } from "@terragon/shared/db/ui-messages";
import { parseGitDiffStats } from "@terragon/shared/utils/git-diff";
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ExternalLink,
  FileDiff,
} from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { parseMultiFileDiff } from "@/lib/git-diff";
import { cn } from "@/lib/utils";
import { FileDiffWrapper } from "./git-diff-view";
import { useSecondaryPanel } from "./hooks";
import type { ArtifactDescriptorLookup } from "./secondary-panel-helpers";
import { findArtifactDescriptorForPart } from "./secondary-panel-helpers";

interface GitDiffPartProps {
  gitDiffPart: UIGitDiffPart;
  artifactDescriptors?: ArtifactDescriptor[];
  artifactDescriptorLookup?: ArtifactDescriptorLookup;
  onOpenArtifact?: (artifactId: string) => void;
  // Flag-gated at the `chat-ui.tsx` producer; `undefined` when the
  // `repoFilePreview` flag is off, so its presence alone enables the per-file
  // open affordance in inline diff headers.
  onOpenRepoFile?: (filePath: string) => void;
  thread?: ThreadInfoFull | null;
  isLatest?: boolean;
}

export const GitDiffPart = memo(function GitDiffPart({
  gitDiffPart,
  artifactDescriptors = [],
  artifactDescriptorLookup,
  onOpenArtifact,
  onOpenRepoFile,
  thread = null,
  isLatest = false,
}: GitDiffPartProps) {
  const { setIsSecondaryPanelOpen } = useSecondaryPanel();
  const isImageDiffViewEnabled = useFeatureFlag("imageDiffView");
  const diffStats = useMemo(
    () => gitDiffPart.diffStats || parseGitDiffStats(gitDiffPart.diff),
    [gitDiffPart.diff, gitDiffPart.diffStats],
  );
  const artifactDescriptor = useMemo(
    () =>
      findArtifactDescriptorForPart({
        artifacts: artifactDescriptors,
        lookup: artifactDescriptorLookup,
        part: gitDiffPart,
      }),
    [artifactDescriptors, artifactDescriptorLookup, gitDiffPart],
  );

  const diffInstances = useMemo(() => {
    if (!gitDiffPart.diff || gitDiffPart.diff === "too-large") return [];

    try {
      return parseMultiFileDiff(gitDiffPart.diff);
    } catch (e) {
      console.error("Failed to create diff instances:", e);
      return [];
    }
  }, [gitDiffPart.diff]);

  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<number, boolean>>(
    () => {
      // Expand by default if there's 1 file with ≤30 total changes
      const shouldExpandFileDiff =
        diffInstances.length === 1 &&
        (diffInstances[0]?.additions ?? 0) +
          (diffInstances[0]?.deletions ?? 0) <=
          30;

      return diffInstances.reduce(
        (acc, _, idx) => {
          acc[idx] = shouldExpandFileDiff;
          return acc;
        },
        {} as Record<number, boolean>,
      );
    },
  );

  if (!diffStats) {
    return null;
  }

  const handleClick = () => {
    setIsExpanded(!isExpanded);
  };

  const handleOpenPanel = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (artifactDescriptor && onOpenArtifact) {
      onOpenArtifact(artifactDescriptor.id);
    } else {
      setIsSecondaryPanelOpen(true);
    }
  };

  // Inline (chat transcript) diff headers get the same open-file affordance as
  // the artifacts-panel diff: when an opener is wired (flag-gated at the
  // producer) and this diff maps to a real artifact, the per-file Open button
  // routes to the same panel-open flow used by the "Open in side panel" button.
  const inlineOnOpenRepoFile =
    onOpenRepoFile && artifactDescriptor && onOpenArtifact
      ? () => onOpenArtifact(artifactDescriptor.id)
      : undefined;

  const toggleFile = (idx: number) => {
    setExpandedFiles((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const toggleAllFiles = (expand: boolean) => {
    const newExpanded: Record<number, boolean> = {};
    diffInstances.forEach((_, idx) => {
      newExpanded[idx] = expand;
    });
    setExpandedFiles(newExpanded);
  };

  const allExpanded = diffInstances.every((_, idx) => expandedFiles[idx]);

  return (
    <div className="flex flex-col rounded-lg bg-surface-soft">
      <div
        className="flex flex-row items-center cursor-pointer select-none justify-between p-2"
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`Files Changed: ${diffStats.files} file${diffStats.files === 1 ? "" : "s"}`}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleClick();
          }
        }}
      >
        <div className="flex items-center gap-3 min-w-0 overflow-hidden flex-1">
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="shrink-0">
              <ChevronRight
                className={cn(
                  "size-4 transition-transform duration-[var(--duration-quick)] ease-[var(--ease-standard)]",
                  isExpanded && "rotate-90",
                )}
              />
            </div>
            <FileDiff className="size-4 flex-shrink-0" />
            <h2 className="text-sm font-medium whitespace-nowrap">
              Files Changed
            </h2>
            {diffStats.files > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 text-xs font-medium rounded-full bg-muted text-muted-foreground flex-shrink-0 tabular-nums">
                {diffStats.files}
              </span>
            )}
          </div>
          {(diffStats.additions > 0 || diffStats.deletions > 0) && (
            <div className="flex items-center gap-2 text-xs font-medium flex-shrink-0 min-w-0 tabular-nums">
              {diffStats.additions > 0 && (
                <span className="flex items-center gap-1 text-[var(--diff-added-fg)] whitespace-nowrap">
                  <span>+{diffStats.additions}</span>
                </span>
              )}
              {diffStats.deletions > 0 && (
                <span className="flex items-center gap-1 text-[var(--diff-removed-fg)] whitespace-nowrap">
                  <span>-{diffStats.deletions}</span>
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isExpanded && diffInstances.length > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleAllFiles(!allExpanded);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
              title={allExpanded ? "Collapse all" : "Expand all"}
              aria-label={
                allExpanded ? "Collapse all files" : "Expand all files"
              }
              aria-pressed={allExpanded}
            >
              {allExpanded ? (
                <ChevronsDownUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronsUpDown className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">
                {allExpanded ? "Collapse" : "Expand"}
              </span>
            </button>
          )}
          <button
            onClick={handleOpenPanel}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
            title="Open in side panel"
            aria-label="Open in side panel"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {isExpanded && (
        <div className="px-2 pb-2">
          {gitDiffPart.diff === "too-large" ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground font-medium">
                Diff too large to display
              </p>
            </div>
          ) : diffInstances.length > 0 && thread ? (
            <div className="flex flex-col gap-1">
              {diffInstances.map((parsedFile, index) => (
                <FileDiffWrapper
                  key={index}
                  parsedFile={parsedFile}
                  mode="unified"
                  expanded={!!expandedFiles[index]}
                  onToggle={() => toggleFile(index)}
                  thread={thread}
                  enableComments={false}
                  isImageDiffViewEnabled={isImageDiffViewEnabled}
                  onOpenRepoFile={inlineOnOpenRepoFile}
                />
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No diff data available
            </div>
          )}
        </div>
      )}
    </div>
  );
});
