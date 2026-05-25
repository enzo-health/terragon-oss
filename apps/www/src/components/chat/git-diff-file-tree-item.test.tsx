import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FileTreeItem } from "./git-diff-file-tree-item";
import { resolveFileTreeItemActivation } from "./git-diff-view.utils";
import type { FileTreeNode } from "./git-diff-view.types";

// The component returns <div>{row}{folderBlock}</div>; pull the row's onClick
// (the activation handler) out so we can drive the click path without a DOM.
function getRowOnClick(element: React.ReactElement): () => void {
  const children = (element.props as { children: React.ReactNode }).children;
  const row = Array.isArray(children) ? children[0] : children;
  return (row as React.ReactElement<{ onClick: () => void }>).props.onClick;
}

const fileNode: FileTreeNode = {
  name: "foo.ts",
  path: "src/foo.ts",
  type: "file",
  fileIndex: 3,
  changeType: "modified",
};

const folderNode: FileTreeNode = {
  name: "src",
  path: "src",
  type: "folder",
  children: [],
};

describe("resolveFileTreeItemActivation (file-tree click path)", () => {
  it("routes a leaf file to open-repo-file when enabled", () => {
    expect(resolveFileTreeItemActivation(fileNode, true)).toEqual({
      kind: "open-repo-file",
      path: "src/foo.ts",
    });
  });

  it("selects the file in place when open-repo-file is disabled (flag off)", () => {
    expect(resolveFileTreeItemActivation(fileNode, false)).toEqual({
      kind: "select-file",
      fileIndex: 3,
    });
  });

  it("always toggles folders regardless of the flag", () => {
    expect(resolveFileTreeItemActivation(folderNode, true)).toEqual({
      kind: "toggle-folder",
      path: "src",
    });
    expect(resolveFileTreeItemActivation(folderNode, false)).toEqual({
      kind: "toggle-folder",
      path: "src",
    });
  });

  it("does nothing for a file node without a fileIndex", () => {
    expect(
      resolveFileTreeItemActivation(
        { name: "x", path: "x", type: "file" },
        true,
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("FileTreeItem onOpenRepoFile click path", () => {
  it("calls onOpenRepoFile with the path and not onFileSelect when enabled", () => {
    const onOpenRepoFile = vi.fn();
    const onFileSelect = vi.fn();
    const element = FileTreeItem({
      node: fileNode,
      selectedFile: null,
      onFileSelect,
      expandedFolders: new Set<string>(),
      onToggleFolder: vi.fn(),
      onOpenRepoFile,
    });

    getRowOnClick(element)();

    expect(onOpenRepoFile).toHaveBeenCalledWith("src/foo.ts");
    expect(onFileSelect).not.toHaveBeenCalled();
  });

  it("falls back to onFileSelect when onOpenRepoFile is absent (flag-off no-op)", () => {
    const onFileSelect = vi.fn();
    const element = FileTreeItem({
      node: fileNode,
      selectedFile: null,
      onFileSelect,
      expandedFolders: new Set<string>(),
      onToggleFolder: vi.fn(),
      // onOpenRepoFile omitted -> unchanged behavior
    });

    getRowOnClick(element)();

    expect(onFileSelect).toHaveBeenCalledWith(3);
  });

  it("exposes an Open affordance only when onOpenRepoFile is provided", () => {
    const withHandler = renderToStaticMarkup(
      <FileTreeItem
        node={fileNode}
        selectedFile={null}
        onFileSelect={vi.fn()}
        expandedFolders={new Set<string>()}
        onToggleFolder={vi.fn()}
        onOpenRepoFile={vi.fn()}
      />,
    );
    expect(withHandler).toContain('data-open-repo-file="true"');
    expect(withHandler).toContain('aria-label="Open foo.ts"');

    const withoutHandler = renderToStaticMarkup(
      <FileTreeItem
        node={fileNode}
        selectedFile={null}
        onFileSelect={vi.fn()}
        expandedFolders={new Set<string>()}
        onToggleFolder={vi.fn()}
      />,
    );
    expect(withoutHandler).not.toContain("data-open-repo-file");
    expect(withoutHandler).toContain('aria-label="foo.ts"');
  });
});
