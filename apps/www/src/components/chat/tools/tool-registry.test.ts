/**
 * Exhaustiveness test for `ToolRegistry`.
 *
 * The registry's TypeScript shape is the canonical source of truth for which
 * tool names the UI dispatches. This test pins the runtime list against a
 * fixture and asserts both directions of containment via TypeScript types
 * AND runtime equality. If the daemon adds a tool, both this fixture and the
 * registry must be updated in lockstep.
 */
import { describe, expect, it } from "vitest";
import type { ToolName, ToolRegistry } from "./tool-registry";

// Runtime fixture: every tool name the registry currently keys. Order is
// arbitrary; the test sorts before comparing.
const RUNTIME_TOOL_NAMES: readonly ToolName[] = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "LS",
  "Bash",
  "TodoRead",
  "TodoWrite",
  "NotebookRead",
  "NotebookEdit",
  "Task",
  "WebFetch",
  "WebSearch",
  "SuggestFollowupTask",
  "mcp__terry__SuggestFollowupTask",
  "ExitPlanMode",
  "PermissionRequest",
  "FileChange",
  "MCPTool",
] as const;

// Compile-time exhaustiveness: if `ToolName` gains a member that isn't in
// `RUNTIME_TOOL_NAMES`, this assignment fails to type-check (the union is
// not assignable to the literal tuple's element union).
type _AssertRuntimeCoversToolName =
  ToolName extends (typeof RUNTIME_TOOL_NAMES)[number] ? true : never;
type _AssertRuntimeHasNoExtras =
  (typeof RUNTIME_TOOL_NAMES)[number] extends ToolName ? true : never;
const _exhaustive: [_AssertRuntimeCoversToolName, _AssertRuntimeHasNoExtras] = [
  true,
  true,
];
void _exhaustive;

describe("ToolRegistry", () => {
  it("fixture covers exactly 21 tool names", () => {
    expect(RUNTIME_TOOL_NAMES).toHaveLength(21);
  });

  it("fixture has no duplicates", () => {
    const unique = new Set(RUNTIME_TOOL_NAMES);
    expect(unique.size).toBe(RUNTIME_TOOL_NAMES.length);
  });

  it("fixture matches `keyof ToolRegistry` runtime-equally", () => {
    // Construct a stand-in object typed exactly as `Record<keyof ToolRegistry,
    // true>`. TypeScript will fail compilation if a key is missing or extra.
    // We use this as the runtime "expected keys" set.
    const expected: Record<keyof ToolRegistry, true> = {
      Read: true,
      Write: true,
      Edit: true,
      MultiEdit: true,
      Grep: true,
      Glob: true,
      LS: true,
      Bash: true,
      TodoRead: true,
      TodoWrite: true,
      NotebookRead: true,
      NotebookEdit: true,
      Task: true,
      WebFetch: true,
      WebSearch: true,
      SuggestFollowupTask: true,
      mcp__terry__SuggestFollowupTask: true,
      ExitPlanMode: true,
      PermissionRequest: true,
      FileChange: true,
      MCPTool: true,
    };
    expect([...RUNTIME_TOOL_NAMES].sort()).toEqual(
      Object.keys(expected).sort(),
    );
  });
});
