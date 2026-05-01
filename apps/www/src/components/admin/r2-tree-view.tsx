"use client";

import { useState } from "react";
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

export function R2TreeView({ initialData = [] }: TreeViewProps) {
  const [data, setData] = useState<TreeNode[]>(initialData);
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<TreeNode | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [nodeToDelete, setNodeToDelete] = useState<TreeNode | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const toggleExpanded = (path: string) => {
    setExpandedNodes((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const handleRefresh = async () => {
    setIsLoading(true);
    try {
      const result = await listR2Objects();
      setData(result.tree);
      toast.success("Refreshed successfully");
    } catch (error) {
      toast.error("Failed to refresh");
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!nodeToDelete) return;

    setIsDeleting(true);
    try {
      await deleteR2Object(nodeToDelete.path);
      toast.success(`Deleted ${nodeToDelete.name}`);
      await handleRefresh();
      setDeleteDialogOpen(false);
      setNodeToDelete(null);
    } catch (error) {
      toast.error("Failed to delete object");
    } finally {
      setIsDeleting(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  };

  const renderNode = (node: TreeNode, level: number = 0) => {
    const isExpanded = expandedNodes.has(node.path);
    const isSelected = selectedNode?.path === node.path;

    return (
      <div key={node.path}>
        <div
          className={`group flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer transition-colors hover:bg-[var(--hover-cream,var(--muted))] ${
            isSelected ? "bg-[var(--hover-cream,var(--muted))]" : ""
          }`}
          style={{ paddingLeft: `${level * 20 + 8}px` }}
          onClick={() => {
            if (node.type === "folder") {
              toggleExpanded(node.path);
            }
            setSelectedNode(node);
          }}
        >
          {node.type === "folder" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(node.path);
              }}
              className="p-0.5"
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          )}
          {node.type === "file" ? (
            <File className="h-4 w-4 text-muted-foreground" />
          ) : (
            <Folder className="h-4 w-4 text-muted-foreground" />
          )}
          <span
            className={`flex-1 text-sm ${node.type === "file" ? "font-mono" : ""}`}
          >
            {node.name}
          </span>
          {node.type === "file" && node.size !== undefined && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatBytes(node.size)}
            </span>
          )}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {node.type === "file" && node.url && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    window.open(node.url!, "_blank");
                  }}
                  title="Open in new tab"
                >
                  <ExternalLink className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyToClipboard(node.url!);
                  }}
                  title="Copy URL"
                >
                  <Copy className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    const a = document.createElement("a");
                    a.href = node.url!;
                    a.download = node.name;
                    a.click();
                  }}
                  title="Download"
                >
                  <Download className="h-3 w-3" />
                </Button>
              </>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-destructive hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                setNodeToDelete(node);
                setDeleteDialogOpen(true);
              }}
              title="Delete"
            >
              <Trash2 className="h-3 w-3" />
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

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between p-4 border-b border-[var(--hairline,var(--border))]">
        <h3 className="text-lg font-semibold">CDN Objects</h3>
        <Button onClick={handleRefresh} disabled={isLoading} size="sm">
          {isLoading ? "Loading..." : "Refresh"}
        </Button>
      </div>

      <div className="flex-1 overflow-auto p-2">
        {data.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            No objects found
          </div>
        ) : (
          data.map((node) => renderNode(node))
        )}
      </div>

      {selectedNode && selectedNode.type === "file" && (
        <div className="border-t border-[var(--hairline,var(--border))] p-4 space-y-2">
          <h4 className="font-medium">File Details</h4>
          <div className="text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Name:</span>
              <span className="font-mono text-xs">{selectedNode.name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Path:</span>
              <span className="font-mono text-xs">{selectedNode.path}</span>
            </div>
            {selectedNode.size !== undefined && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Size:</span>
                <span className="tabular-nums">
                  {formatBytes(selectedNode.size)}
                </span>
              </div>
            )}
            {selectedNode.lastModified && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Modified:</span>
                {format(selectedNode.lastModified, "MMM d, yyyy h:mm a zzz")}
              </div>
            )}
            {selectedNode.url && (
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">URL:</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => copyToClipboard(selectedNode.url!)}
                >
                  Copy URL
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {nodeToDelete?.type === "folder" ? "Folder" : "File"}
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{nodeToDelete?.name}"? This
              action cannot be undone.
              {nodeToDelete?.type === "folder" &&
                " All files inside this folder will also be deleted."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDelete}
              disabled={isDeleting}
              variant="destructive"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
