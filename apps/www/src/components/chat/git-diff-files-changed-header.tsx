"use client";

import {
  ChevronsDownUp,
  ChevronsUpDown,
  PanelLeft,
  PanelLeftClose,
} from "lucide-react";
import { DiffModeToggle } from "@/components/shared/diff-view";

export function FilesChangedHeader({
  fileCount,
  viewMode,
  onViewModeChange,
  allExpanded,
  onToggleAll,
  showFileTree,
  onToggleFileTree,
  additions,
  deletions,
  isSmallScreen,
  fileTreeId,
}: {
  fileCount: number;
  viewMode: "split" | "unified";
  onViewModeChange: (mode: "split" | "unified") => void;
  allExpanded: boolean;
  onToggleAll: () => void;
  showFileTree: boolean;
  onToggleFileTree: () => void;
  additions: number;
  deletions: number;
  isSmallScreen: boolean;
  fileTreeId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-1.5 bg-accent/30">
      <div className="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
        <span className="text-[12px] font-medium text-foreground/80 whitespace-nowrap">
          {fileCount} file{fileCount !== 1 ? "s" : ""}
        </span>
        {(additions > 0 || deletions > 0) && (
          <div className="flex items-center gap-1.5 text-[11px] font-medium flex-shrink-0">
            {additions > 0 && (
              <span className="text-green-600 dark:text-green-400">
                +{additions}
              </span>
            )}
            {deletions > 0 && (
              <span className="text-red-600 dark:text-red-400">
                -{deletions}
              </span>
            )}
          </div>
        )}
      </div>
      {fileCount > 0 && (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={onToggleFileTree}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
            title={showFileTree ? "Hide file tree" : "Show file tree"}
            aria-label={
              showFileTree ? "Hide changed files" : "Show changed files"
            }
            aria-expanded={showFileTree}
            aria-controls={fileTreeId}
          >
            {showFileTree ? (
              <PanelLeftClose className="w-3.5 h-3.5" />
            ) : (
              <PanelLeft className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onToggleAll}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md hover:bg-muted transition-colors"
            title={allExpanded ? "Collapse all" : "Expand all"}
            aria-label={allExpanded ? "Collapse all files" : "Expand all files"}
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
          {!isSmallScreen && (
            <DiffModeToggle
              mode={viewMode}
              onModeChange={onViewModeChange}
              className="py-0.5 px-0.5"
            />
          )}
        </div>
      )}
    </div>
  );
}
