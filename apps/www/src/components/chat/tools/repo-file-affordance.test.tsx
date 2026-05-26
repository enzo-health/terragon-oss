/* @vitest-environment jsdom */

import type { AllToolParts } from "@terragon/shared";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToolPart, type ToolRenderContext } from "../tool-part";

const FILE_PATH = "src/components/button.tsx";

function makeReadPart(): Extract<AllToolParts, { name: "Read" }> {
  return {
    type: "tool",
    agent: "claudeCode",
    id: "read-1",
    name: "Read",
    parameters: { file_path: FILE_PATH },
    status: "completed",
    parts: [],
    result: "1\tconst a = 1;",
  };
}

function makeWritePart(): Extract<AllToolParts, { name: "Write" }> {
  return {
    type: "tool",
    agent: "claudeCode",
    id: "write-1",
    name: "Write",
    parameters: { file_path: FILE_PATH, content: "const a = 1;\n" },
    status: "completed",
    parts: [],
    result: "ok",
  };
}

function makeEditPart(): Extract<AllToolParts, { name: "Edit" }> {
  return {
    type: "tool",
    agent: "claudeCode",
    id: "edit-1",
    name: "Edit",
    parameters: { file_path: FILE_PATH, old_string: "a", new_string: "b" },
    status: "completed",
    parts: [],
    result: "ok",
  };
}

function makeMultiEditPart(): Extract<AllToolParts, { name: "MultiEdit" }> {
  return {
    type: "tool",
    agent: "claudeCode",
    id: "multi-1",
    name: "MultiEdit",
    parameters: {
      file_path: FILE_PATH,
      edits: [{ old_string: "a", new_string: "b" }],
    },
    status: "completed",
    parts: [],
    result: "ok",
  };
}

function makeFileChangePart(): Extract<AllToolParts, { name: "FileChange" }> {
  return {
    type: "tool",
    agent: "claudeCode",
    id: "fc-1",
    name: "FileChange",
    parameters: { files: [{ path: FILE_PATH, action: "modified" }] },
    status: "completed",
    parts: [],
    result: "{}",
  };
}

function makeCtx(
  overrides: Partial<ToolRenderContext> = {},
): ToolRenderContext {
  return {
    threadId: "thread-1",
    threadChatId: "chat-1",
    isReadOnly: false,
    childThreads: [],
    githubRepoFullName: "owner/repo",
    repoBaseBranchName: "main",
    branchName: "feature",
    artifactDescriptors: [],
    renderChildToolPart: () => null as ReactNode,
    ...overrides,
  };
}

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

describe("repo-file affordance in tool renderers", () => {
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

  const fileToolCases: Array<{
    name: string;
    part: AllToolParts;
    testId: string;
  }> = [
    { name: "Read", part: makeReadPart(), testId: "tool-arg-open-file" },
    { name: "Write", part: makeWritePart(), testId: "tool-arg-open-file" },
    { name: "Edit", part: makeEditPart(), testId: "tool-arg-open-file" },
    {
      name: "MultiEdit",
      part: makeMultiEditPart(),
      testId: "tool-arg-open-file",
    },
    {
      name: "FileChange",
      part: makeFileChangePart(),
      testId: "tool-arg-open-file",
    },
  ];

  for (const { name, part, testId } of fileToolCases) {
    it(`${name}: routes click to ctx.onOpenRepoFile when an opener is wired`, () => {
      const onOpenRepoFile = vi.fn();
      mount(renderToolPart(part, makeCtx({ onOpenRepoFile })));
      expect(clickFirst(testId)).toBe(true);
      expect(onOpenRepoFile).toHaveBeenCalledTimes(1);
      expect(onOpenRepoFile).toHaveBeenCalledWith(FILE_PATH);
    });

    it(`${name}: no affordance when no opener is wired (flag off)`, () => {
      mount(renderToolPart(part, makeCtx({ onOpenRepoFile: undefined })));
      const el = container?.querySelector(`[data-testid="${testId}"]`);
      expect(el).toBeNull();
    });
  }
});
