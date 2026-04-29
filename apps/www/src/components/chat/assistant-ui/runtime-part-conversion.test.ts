import { describe, expect, it } from "vitest";
import {
  runtimePartToTerragonPart,
  type RuntimeMessagePartState,
} from "./runtime-part-conversion";

describe("runtimePartToTerragonPart", () => {
  it("projects wrapped terragon.data-part payloads", () => {
    const part = {
      type: "data",
      name: "terragon.terminal",
      data: {
        name: "terragon.terminal",
        messageId: "assistant-1",
        partIndex: 0,
        data: {
          type: "terminal",
          sandboxId: "sandbox-1",
          terminalId: "terminal-1",
          chunks: [],
        },
      },
      status: { type: "complete" },
      dataRendererUI: null,
    } satisfies RuntimeMessagePartState;

    expect(runtimePartToTerragonPart(part, "codex")).toEqual({
      type: "terminal",
      sandboxId: "sandbox-1",
      terminalId: "terminal-1",
      chunks: [],
    });
  });

  it("rejects unwrapped data payloads", () => {
    const part = {
      type: "data",
      name: "terragon.terminal",
      data: {
        type: "terminal",
        sandboxId: "sandbox-1",
        terminalId: "terminal-1",
        chunks: [],
      },
      status: { type: "complete" },
      dataRendererUI: null,
    } satisfies RuntimeMessagePartState;

    expect(runtimePartToTerragonPart(part, "codex")).toBeNull();
  });

  it("rejects diff data parts so diffs stay on the FileChange tool path", () => {
    const part = {
      type: "data",
      name: "terragon.diff",
      data: {
        name: "terragon.diff",
        messageId: "assistant-1",
        partIndex: 0,
        data: {
          type: "diff",
          filePath: "apps/www/src/components/chat/example.ts",
          newContent: "export const value = true;\n",
          status: "applied",
        },
      },
      status: { type: "complete" },
      dataRendererUI: null,
    } satisfies RuntimeMessagePartState;

    expect(runtimePartToTerragonPart(part, "codex")).toBeNull();
  });
});
