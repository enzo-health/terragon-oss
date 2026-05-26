/* @vitest-environment jsdom */

/**
 * End-to-end wiring test for the `repoFilePreview` file-path affordance.
 *
 * The renderer-level test (`tools/repo-file-affordance.test.tsx`) hand-builds a
 * `ToolRenderContext` and proves the five file renderers route clicks. That
 * test does NOT exercise the production dispatch path, where the opener has to
 * travel `chat-ui toolProps` → `PartRegistryContext.toolProps` → the registry
 * `tool`/`diff` entries → the renderer. The dead-wiring regression lived in
 * exactly that gap (the registry forwarded `onOpenArtifact` but not
 * `onOpenRepoFile`). These tests dispatch through `renderPartFromRegistry` —
 * the same entry point `message-part.tsx` uses — so the forwarding is covered.
 */

import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIPartExtended } from "../ui-parts-extended";
import {
  type PartRegistryContext,
  renderPartFromRegistry,
} from "./part-registry";

const FILE_PATH = "src/components/button.tsx";

function makeCtx(
  toolPropsOverrides: Partial<PartRegistryContext["toolProps"]> = {},
): PartRegistryContext {
  return {
    isLatest: false,
    isAgentWorking: false,
    toolProps: {
      threadId: "t1",
      threadChatId: "c1",
      isReadOnly: false,
      childThreads: [],
      githubRepoFullName: "owner/repo",
      repoBaseBranchName: "main",
      branchName: null,
      ...toolPropsOverrides,
    },
    artifactDescriptors: [],
    artifactDescriptor: null,
    githubRepoFullName: "owner/repo",
    branchName: null,
    baseBranchName: "main",
    hasCheckpoint: false,
  };
}

const readPart: Extract<UIPartExtended, { type: "tool" }> = {
  type: "tool",
  name: "Read",
  id: "tool-read-1",
  parameters: { file_path: FILE_PATH },
  parts: [],
  agent: "claudeCode",
  status: "completed",
  result: "1\tconst a = 1;",
};

const diffPart: Extract<UIPartExtended, { type: "diff" }> = {
  type: "diff",
  filePath: FILE_PATH,
  newContent: "const a = 1;\n",
  status: "applied",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<>{node}</>);
  });
}

function clickFirst(testId: string): boolean {
  const el = container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!el) return false;
  act(() => {
    el.click();
  });
  return true;
}

describe("repoFilePreview wiring through PART_REGISTRY", () => {
  beforeEach(() => {
    container = null;
    root = null;
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    if (container) {
      container.remove();
    }
    vi.restoreAllMocks();
  });

  it("tool entry forwards toolProps.onOpenRepoFile when an opener is wired", () => {
    const onOpenRepoFile = vi.fn();
    mount(renderPartFromRegistry(makeCtx({ onOpenRepoFile }), readPart));
    expect(clickFirst("tool-arg-open-file")).toBe(true);
    expect(onOpenRepoFile).toHaveBeenCalledTimes(1);
    expect(onOpenRepoFile).toHaveBeenCalledWith(FILE_PATH);
  });

  it("tool entry renders no affordance when no opener is wired (flag off)", () => {
    mount(
      renderPartFromRegistry(makeCtx({ onOpenRepoFile: undefined }), readPart),
    );
    expect(
      container?.querySelector(`[data-testid="tool-arg-open-file"]`),
    ).toBeNull();
  });

  it("diff entry forwards the opener to the git-diff header (R4) when an opener is wired", () => {
    const onOpenRepoFile = vi.fn();
    mount(renderPartFromRegistry(makeCtx({ onOpenRepoFile }), diffPart));
    expect(clickFirst("diff-header-open-file")).toBe(true);
    expect(onOpenRepoFile).toHaveBeenCalledTimes(1);
    expect(onOpenRepoFile).toHaveBeenCalledWith(FILE_PATH);
  });

  it("diff entry renders a plain header when no opener is wired (flag off)", () => {
    mount(
      renderPartFromRegistry(makeCtx({ onOpenRepoFile: undefined }), diffPart),
    );
    expect(
      container?.querySelector(`[data-testid="diff-header-open-file"]`),
    ).toBeNull();
  });
});
