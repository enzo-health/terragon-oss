import { describe, expect, it } from "vitest";
import type { UIUserOrAgentPart } from "../chat-message.types";
import { summarizeActivityGroup } from "./activity-summary";

function tool(
  name: string,
  parameters: Record<string, unknown> = {},
): UIUserOrAgentPart {
  return { type: "tool", name, parameters } as unknown as UIUserOrAgentPart;
}

function text(value: string): UIUserOrAgentPart {
  return { type: "text", text: value } as unknown as UIUserOrAgentPart;
}

describe("summarizeActivityGroup", () => {
  it("aggregates the Codex example: explored files, a search, a command", () => {
    const summary = summarizeActivityGroup([
      tool("Read", { file_path: "a.ts" }),
      tool("Read", { file_path: "b.ts" }),
      tool("Read", { file_path: "c.ts" }),
      tool("Read", { file_path: "d.ts" }),
      tool("Grep", { pattern: "foo" }),
      tool("LS", { path: "src" }),
      tool("Bash", { command: "pnpm test" }),
    ]);
    expect(summary).toBe("Explored 4 files, 1 search, 1 list, ran 1 command");
  });

  it("leads with creates and edits, capitalized", () => {
    const summary = summarizeActivityGroup([
      tool("Write", { file_path: "new.ts" }),
      tool("Edit", { file_path: "old.ts" }),
      tool("MultiEdit", { file_path: "other.ts" }),
      tool("Bash", { command: "git status" }),
    ]);
    expect(summary).toBe("Created 1 file, edited 2 files, ran 1 command");
  });

  it("de-duplicates explored/edited file paths", () => {
    const summary = summarizeActivityGroup([
      tool("Read", { file_path: "same.ts" }),
      tool("Read", { file_path: "same.ts" }),
      tool("Read", { file_path: "same.ts" }),
    ]);
    expect(summary).toBe("Explored 1 file");
  });

  it("pluralizes searches and lists correctly", () => {
    expect(
      summarizeActivityGroup([
        tool("Grep", { pattern: "a" }),
        tool("Glob", { pattern: "*.ts" }),
        tool("LS", { path: "x" }),
        tool("LS", { path: "y" }),
      ]),
    ).toBe("2 searches, 2 lists");
  });

  it("buckets read-only bash commands as explored/search/list, not command", () => {
    expect(
      summarizeActivityGroup([tool("Bash", { command: "cat package.json" })]),
    ).toBe("Explored 1 file");
    expect(
      summarizeActivityGroup([tool("Bash", { command: "rg TODO src" })]),
    ).toBe("1 search");
    expect(summarizeActivityGroup([tool("Bash", { command: "ls -la" })])).toBe(
      "1 list",
    );
  });

  it("unwraps bash -lc wrappers before classifying", () => {
    expect(
      summarizeActivityGroup([
        tool("Bash", { command: `/bin/bash -lc "rg pattern apps"` }),
      ]),
    ).toBe("1 search");
    expect(
      summarizeActivityGroup([
        tool("Bash", { command: `bash -lc 'pnpm build'` }),
      ]),
    ).toBe("Ran 1 command");
  });

  it("ignores leading env assignments", () => {
    expect(
      summarizeActivityGroup([
        tool("Bash", { command: "FOO=bar grep needle file" }),
      ]),
    ).toBe("1 search");
  });

  it("hides todo and bookkeeping tools from the count", () => {
    expect(
      summarizeActivityGroup([
        tool("TodoWrite", {}),
        tool("TodoRead", {}),
        tool("Read", { file_path: "a.ts" }),
      ]),
    ).toBe("Explored 1 file");
  });

  it("folds unknown/MCP/Task tools into the command bucket", () => {
    expect(
      summarizeActivityGroup([
        tool("mcp__server__doThing", {}),
        tool("Task", { description: "sub" }),
      ]),
    ).toBe("Ran 2 commands");
  });

  it("returns null when there is no countable tool activity", () => {
    expect(summarizeActivityGroup([text("hello"), text("world")])).toBeNull();
    expect(summarizeActivityGroup([tool("TodoWrite", {})])).toBeNull();
    expect(summarizeActivityGroup([])).toBeNull();
  });
});
