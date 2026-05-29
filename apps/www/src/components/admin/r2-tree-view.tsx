"use client";

import { useReducer } from "react";
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  Trash2,
  ExternalLink,
  Copy,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  listR2Objects,
  deleteR2Object,
} from "@/server-actions/admin/r2-objects";
import { formatBytes } from "@/lib/utils";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  size?: number;
  lastModified?: Date;
  url?: string | null;
}

interface TreeViewProps {
  initialData?: TreeNode[];
}

const EMPTY_TREE_DATA: TreeNode[] = [];

type R2TreeState = {
  data: TreeNode[];
  expandedNodes: Set<string>;
  selectedNode: TreeNode | null;
  deleteDialogOpen: boolean;
  nodeToDelete: TreeNode | null;
  isDeleting: boolean;
  isLoading: boolean;
};

type R2TreeAction =
  | { type: "toggle-expanded"; path: string }
  | { type: "select-node"; node: TreeNode }
  | { type: "refresh-start" }
  | { type: "refresh-success"; data: TreeNode[] }
  | { type: "refresh-error" }
  | { type: "request-delete"; node: TreeNode }
  | { type: "close-delete-dialog" }
  | { type: "delete-start" }
  | { type: "delete-success" }
  | { type: "delete-error" };

function r2TreeReducer(state: R2TreeState, action: R2TreeAction): R2TreeState {
  switch (action.type) {
    case "toggle-expanded": {
      const expandedNodes = new Set(state.expandedNodes);
      if (expandedNodes.has(action.path)) {
        expandedNodes.delete(action.path);
      } else {
        expandedNodes.add(action.path);
      }
      return { ...state, expandedNodes };
    }
    case "select-node":
      return { ...state, selectedNode: action.node };
    case "refresh-start":
      return { ...state, isLoading: true };
    case "refresh-success":
      return { ...state, data: action.data, isLoading: false };
    case "refresh-error":
      return { ...state, isLoading: false };
    case "request-delete":
      return {
        ...state,
        deleteDialogOpen: true,
        nodeToDelete: action.node,
      };
    case "close-delete-dialog":
      return { ...state, deleteDialogOpen: false };
    case "delete-start":
      return { ...state, isDeleting: true };
    case "delete-success":
      return {
        ...state,
        deleteDialogOpen: false,
        nodeToDelete: null,
        isDeleting: false,
      };
    case "delete-error":
      return { ...state, isDeleting: false };
  }
}

export function R2TreeView({ initialData = EMPTY_TREE_DATA }: TreeViewProps) {
  const [state, dispatch] = useReducer(r2TreeReducer, {
    data: initialData,
    expandedNodes: new Set<string>(),
    selectedNode: null,
    deleteDialogOpen: false,
    nodeToDelete: null,
    isDeleting: false,
    isLoading: false,
  });

  const toggleExpanded = (path: string) => {
    dispatch({ type: "toggle-expanded", path });
  };

  const handleRefresh = async () => {
    dispatch({ type: "refresh-start" });
    try {
      const result = await listR2Objects();
      dispatch({ type: "refresh-success", data: result.tree });
      toast.success("Refreshed successfully");
    } catch (error) {
      toast.error("Failed to refresh");
      dispatch({ type: "refresh-error" });
    }
  };

  const handleDelete = async () => {
    if (!state.nodeToDelete) return;

    dispatch({ type: "delete-start" });
    try {
      await deleteR2Object(state.nodeToDelete.path);
      toast.success(`Deleted ${state.nodeToDelete.name}`);
      await handleRefresh();
      dispatch({ type: "delete-success" });
    } catch (error) {
      toast.error("Failed to delete object");
      dispatch({ type: "delete-error" });
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  };

  const renderNode = (node: TreeNode, level: number = 0) => {
    const isExpanded = state.expandedNodes.has(node.path);
    const isSelected = state.selectedNode?.path === node.path;
    const selectNode = () => {
      if (node.type === "folder") {
        toggleExpanded(node.path);
      }
      dispatch({ type: "select-node", node });
    };

    return (
      <div key={node.path}>
        <div
          className={`group flex items-center gap-2 rounded-lg transition-colors hover:bg-[var(--hover-cream,var(--muted))] ${
            isSelected ? "bg-[var(--hover-cream,var(--muted))]" : ""
          }`}
          style={{ paddingLeft: `${level * 20 + 8}px` }}
        >
          <button
            type="button"
            onClick={selectNode}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left"
            aria-label={`${node.type === "folder" ? (isExpanded ? "Collapse" : "Expand") : "Select"} ${node.name}`}
          >
            {node.type === "folder" ? (
              isExpanded ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )
            ) : null}
            {node.type === "file" ? (
              <File className="size-4 text-muted-foreground" />
            ) : (
              <Folder className="size-4 text-muted-foreground" />
            )}
            <span
              className={`min-w-0 flex-1 truncate text-sm ${node.type === "file" ? "font-mono" : ""}`}
            >
              {node.name}
            </span>
            {node.type === "file" && node.size !== undefined && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatBytes(node.size)}
              </span>
            )}
          </button>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {node.type === "file" && node.url && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(node.url!, "_blank");
                  }}
                  title="Open in new tab"
                >
                  <ExternalLink className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyToClipboard(node.url!);
                  }}
                  title="Copy URL"
                >
                  <Copy className="size-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    const a = document.createElement("a");
                    a.href = node.url!;
                    a.download = node.name;
                    a.click();
                  }}
                  title="Download"
                >
                  <Download className="size-3" />
                </Button>
              </>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-6 text-destructive hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: "request-delete", node });
              }}
              title="Delete"
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        </div>
        {node.type === "folder" && isExpanded && node.children && (
          <div>
            {node.children.map((child) => renderNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  const selectedFile =
    state.selectedNode?.type === "file" ? state.selectedNode : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-[var(--hairline,var(--border))]">
        <h3 className="text-lg font-semibold">CDN Objects</h3>
        <Button
          type="button"
          onClick={handleRefresh}
          disabled={state.isLoading}
          size="sm"
        >
          {state.isLoading ? "Loading…" : "Refresh"}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {state.data.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No objects found
          </div>
        ) : (
          state.data.map((node) => renderNode(node))
        )}
      </div>

      {selectedFile && (
        <div className="border-t border-[var(--hairline,var(--border))] p-4 space-y-2">
          <h4 className="font-medium">File Details</h4>
          <div className="text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Name:</span>
              <span className="font-mono text-xs">{selectedFile.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Path:</span>
              <span className="font-mono text-xs">{selectedFile.path}</span>
            </div>
            {selectedFile.size !== undefined && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Size:</span>
                <span className="tabular-nums">
                  {formatBytes(selectedFile.size)}
                </span>
              </div>
            )}
            {selectedFile.lastModified && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Modified:</span>
                {format(selectedFile.lastModified, "MMM d, yyyy h:mm a zzz")}
              </div>
            )}
            {selectedFile.url && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">URL:</span>
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => copyToClipboard(selectedFile.url ?? "")}
                >
                  Copy URL
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={state.deleteDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            dispatch({ type: "close-delete-dialog" });
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {state.nodeToDelete?.type === "folder" ? "Folder" : "File"}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{state.nodeToDelete?.name}"? This
              action cannot be undone.
              {state.nodeToDelete?.type === "folder" &&
                " All files inside this folder will also be deleted."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => dispatch({ type: "close-delete-dialog" })}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleDelete}
              disabled={state.isDeleting}
              variant="destructive"
            >
              {state.isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
