/* @vitest-environment jsdom */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptItem } from "../transcript-store";
import { LEAF, renderLeaf } from "./registry";

const ALL_KINDS: TranscriptItem["kind"][] = [
  "text",
  "reasoning",
  "user",
  "tool",
  "terminal",
  "diff",
  "plan",
  "permission",
  "sources",
  "delegation",
  "image",
  "attachment",
  "error",
  "transient-retry",
  "compaction",
  "unknown-part",
];

const base = { runId: "run-1", seq: 0 } as const;

function sampleItem(kind: TranscriptItem["kind"]): TranscriptItem {
  switch (kind) {
    case "text":
      return {
        ...base,
        kind,
        key: "text:m",
        messageId: "m",
        text: "Hello **world**",
        streaming: true,
      };
    case "reasoning":
      return {
        ...base,
        kind,
        key: "reasoning:m",
        messageId: "m",
        text: "thinking...",
        streaming: true,
        steps: [{ text: "step one" }],
      };
    case "user":
      return {
        ...base,
        kind,
        key: "user:u",
        messageId: "u",
        content: [
          { type: "text", text: "hi there" },
          { type: "image", url: "https://example.com/a.png" },
        ],
      };
    case "tool":
      return {
        ...base,
        kind,
        key: "tool:t",
        toolCallId: "t",
        name: "Bash",
        argsText: '{"command":"ls -la"}',
        parsedArgs: { command: "ls -la" },
        result: "file.txt",
        isError: false,
        status: "success",
        streamingArgs: false,
        parentMessageId: null,
      };
    case "terminal":
      return {
        ...base,
        kind,
        key: "terminal:x",
        terminalId: "x",
        chunks: [
          { streamSeq: 0, stream: "stdout", text: "building\n" },
          { streamSeq: 1, stream: "stderr", text: "warn\n" },
        ],
        exitCode: null,
      };
    case "diff":
      return {
        ...base,
        kind,
        key: "diff:d",
        diffId: "d",
        filePath: "src/a.ts",
        oldContent: "const a = 1;\n",
        newContent: "const a = 2;\n",
        unifiedDiff: null,
        changeKind: "modified",
        status: "pending",
      };
    case "plan":
      return {
        ...base,
        kind,
        key: "plan:p",
        planId: "p",
        entries: [
          { id: "1", content: "do a", status: "completed", priority: null },
          { id: "2", content: "do b", status: "in_progress", priority: "high" },
          { id: "3", content: "do c", status: "pending", priority: null },
        ],
      };
    case "permission":
      return {
        ...base,
        kind,
        key: "part:perm",
        permissionRequestId: "perm",
        title: "Run rm -rf",
        description: "Dangerous command",
        options: [
          { kind: "approve", name: "Approve", optionId: "approved" },
          { kind: "deny", name: "Deny", optionId: "denied" },
        ],
        decision: null,
        status: "pending",
      };
    case "sources":
      return {
        ...base,
        kind,
        key: "part:src",
        sourcesId: "src",
        query: "how to fold",
        sources: [{ url: "https://example.com/x", title: "Example" }],
      };
    case "delegation":
      return {
        ...base,
        kind,
        key: "part:del",
        delegationId: "del",
        agentName: "reviewer",
        activities: [{ seq: 0, text: "reviewing", status: "running" }],
        status: "running",
      };
    case "image":
      return {
        ...base,
        kind,
        key: "part:img",
        imageId: "img",
        mimeType: "image/png",
        url: "https://example.com/a.png",
        data: null,
      };
    case "attachment":
      return {
        ...base,
        kind,
        key: "part:att",
        attachmentId: "att",
        name: "notes.txt",
        mimeType: "text/plain",
        url: "https://example.com/notes.txt",
        size: 2048,
      };
    case "error":
      return {
        ...base,
        kind,
        key: "part:err",
        errorId: "err",
        message: "Something broke",
        stack: "at foo (a.ts:1)\nat bar (b.ts:2)",
      };
    case "transient-retry":
      return {
        ...base,
        kind,
        key: "part:retry",
        retryId: "retry",
        message: "Rate limited, retrying",
        retryAfterMs: 5000,
      };
    case "compaction":
      return { ...base, kind, key: "compaction:c", compactionId: "c" };
    case "unknown-part":
      return {
        ...base,
        kind,
        key: "unknown:z",
        partId: "z",
        label: "Unsupported: mystery",
        source: "rich-part",
        name: "mystery",
        data: { foo: 1 },
      };
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("LEAF registry", () => {
  it("has exactly one leaf per transcript-item kind", () => {
    expect(Object.keys(LEAF).sort()).toEqual([...ALL_KINDS].sort());
  });

  it.each(ALL_KINDS)("renders the %s leaf without throwing", (kind) => {
    const item = sampleItem(kind);
    act(() => {
      root.render(createElement(() => renderLeaf(item)));
    });
    expect(container.textContent).not.toBeNull();
  });
});

describe("leaf content", () => {
  it("renders user text and reasoning steps", () => {
    act(() => {
      root.render(createElement(() => renderLeaf(sampleItem("user"))));
    });
    expect(container.textContent).toContain("hi there");
  });

  it("shows a plan checklist with completed count", () => {
    act(() => {
      root.render(createElement(() => renderLeaf(sampleItem("plan"))));
    });
    expect(container.textContent).toContain("Plan (1/3)");
    expect(container.textContent).toContain("do a");
    expect(container.textContent).toContain("do b");
  });

  it("labels an unknown part with its fallback label", () => {
    act(() => {
      root.render(createElement(() => renderLeaf(sampleItem("unknown-part"))));
    });
    expect(container.textContent).toContain("Unsupported: mystery");
  });

  it("renders a pending permission with approve/deny affordances", () => {
    act(() => {
      root.render(createElement(() => renderLeaf(sampleItem("permission"))));
    });
    expect(container.textContent).toContain("Run rm -rf");
  });
});
