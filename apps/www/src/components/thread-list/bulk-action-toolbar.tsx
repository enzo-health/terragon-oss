"use client";

import { memo, useState, useCallback } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  threadSelectionAtom,
  exitSelectionModeAtom,
  selectAllThreadsAtom,
  deselectAllThreadsAtom,
} from "@/atoms/user-cookies";
import { Button } from "@/components/ui/button";
import {
  Archive,
  ArchiveRestore,
  Trash2,
  X,
  CheckSquare,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  useBulkArchiveMutation,
  useBulkDeleteMutation,
} from "@/queries/thread-mutations";
import { TaskDeleteConfirmationModal } from "@/components/delete-confirmation-dialog";
import { toast } from "sonner";

export const BulkActionToolbar = memo(function BulkActionToolbar({
  threadIds,
  viewFilter,
}: {
  threadIds: string[];
  viewFilter: "active" | "archived";
}) {
  const selection = useAtomValue(threadSelectionAtom);
  const exitSelectionMode = useSetAtom(exitSelectionModeAtom);
  const selectAll = useSetAtom(selectAllThreadsAtom);
  const deselectAll = useSetAtom(deselectAllThreadsAtom);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const bulkArchiveMutation = useBulkArchiveMutation();
  const bulkDeleteMutation = useBulkDeleteMutation();

  const selectedCount = selection.selectedIds.size;
  const allSelected =
    selectedCount === threadIds.length && threadIds.length > 0;

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      deselectAll();
    } else {
      selectAll(threadIds);
    }
  }, [allSelected, threadIds, selectAll, deselectAll]);

  const handleArchive = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    const isArchiving = viewFilter === "active";

    const result = await bulkArchiveMutation.mutateAsync({
      threadIds: ids,
      archive: isArchiving,
    });

    if (result.failed.length > 0) {
      toast.error(
        `Failed to ${isArchiving ? "archive" : "unarchive"} ${result.failed.length} task${result.failed.length === 1 ? "" : "s"}`,
      );
    } else {
      toast.success(
        `${isArchiving ? "Archived" : "Unarchived"} ${result.succeeded.length} task${result.succeeded.length === 1 ? "" : "s"}`,
      );
    }

    exitSelectionMode();
  }, [
    selection.selectedIds,
    viewFilter,
    bulkArchiveMutation,
    exitSelectionMode,
  ]);

  const handleDelete = useCallback(async () => {
    const ids = Array.from(selection.selectedIds);
    const result = await bulkDeleteMutation.mutateAsync(ids);

    if (result.failed.length > 0) {
      toast.error(
        `Failed to delete ${result.failed.length} task${result.failed.length === 1 ? "" : "s"}`,
      );
    } else {
      toast.success(
        `Deleted ${result.succeeded.length} task${result.succeeded.length === 1 ? "" : "s"}`,
      );
    }

    setShowDeleteDialog(false);
    exitSelectionMode();
  }, [selection.selectedIds, bulkDeleteMutation, exitSelectionMode]);

  if (!selection.isSelectionMode) {
    return null;
  }

  return (
    <>
      <div
        className={cn(
          "sticky top-0 z-30 bg-background border-b px-3 py-2 flex items-center justify-between gap-2 animate-in slide-in-from-top-2 duration-200",
        )}
      >
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSelectAll}
            className="h-8 gap-1.5 text-xs font-medium"
          >
            {allSelected ? (
              <>
                <CheckSquare className="h-4 w-4" />
                <span>Deselect all</span>
              </>
            ) : (
              <>
                <Square className="h-4 w-4" />
                <span>Select all</span>
              </>
            )}
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {selectedCount} selected
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleArchive}
            disabled={selectedCount === 0 || bulkArchiveMutation.isPending}
            className="h-8 gap-1.5 text-xs font-medium"
          >
            {viewFilter === "active" ? (
              <Archive className="h-4 w-4" />
            ) : (
              <ArchiveRestore className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {viewFilter === "active" ? "Archive" : "Unarchive"}
            </span>
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowDeleteDialog(true)}
            disabled={selectedCount === 0 || bulkDeleteMutation.isPending}
            className="h-8 gap-1.5 text-xs font-medium text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            <span className="hidden sm:inline">Delete</span>
          </Button>

          <div className="w-px h-4 bg-border mx-1" />

          <Button
            variant="ghost"
            size="icon"
            onClick={() => exitSelectionMode()}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <TaskDeleteConfirmationModal
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={handleDelete}
        itemCount={selectedCount}
      />
    </>
  );
});
