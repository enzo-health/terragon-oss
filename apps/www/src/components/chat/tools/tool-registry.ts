/**
 * Typed map of tool name → { args, result } for `makeAssistantToolUI` registrations.
 *
 * Phase 3a (refactor/chat-layer-consolidated-plan, 2026-04-27): a single source of
 * truth so `makeAssistantToolUI<ToolArgs<T>, ToolResult>` calls in Phase 3b are
 * real generics, not `<any, any>`.
 *
 * Typing sources:
 *
 * - `args` is sourced from the existing `AllToolParts` discriminated union in
 *   `packages/shared/src/db/ui-messages.ts`. That union already keys each tool to
 *   its `parameters` shape via the (non-exported) `ToolParams` interface, so
 *   `Extract<AllToolParts, { name: T }>["parameters"]` is the canonical type. We
 *   re-derive here instead of duplicating per-tool param literals — when the daemon
 *   adds a tool, updating `AllToolParts` flows to this registry automatically.
 *
 * - `result` is the daemon's tool-result payload. Today every completed tool call
 *   is persisted as `UICompletedToolPart.result: string` (ui-messages.ts:183) and
 *   each tool component reads that string directly. We type result as `string` to
 *   match the wire shape after daemon normalization. If individual tools start
 *   surfacing structured results to the UI, narrow per entry — do not widen the
 *   whole map.
 *
 * Tools tracked here mirror the `switch (toolPart.name)` in
 * `apps/www/src/components/chat/tool-part.tsx`. Two non-obvious branches:
 *
 *   - `MCPTool`: Codex emits `{ name: "MCPTool", parameters: { server, tool, ... } }`.
 *     The renderer rewrites the name to `mcp__server__tool` before falling through
 *     to `DefaultTool`. We type the registry entry as the raw daemon shape since
 *     `MCPTool` is not in `AllToolParts`.
 *   - `mcp__terry__SuggestFollowupTask`: alias the renderer collapses onto
 *     `SuggestFollowupTask`. Both names route to the same component with the same
 *     args, so we mirror them in the registry.
 *
 * The trailing `UIToolPart<string, Record<string, any>>` arm of `AllToolParts` (the
 * "unknown tool" fallback rendered by `DefaultTool`) is intentionally NOT in the
 * registry: by definition there is no compile-time name for it. `DefaultTool`
 * accepts the raw `parameters` JSON.
 */

import type { AllToolParts } from "@terragon/shared";

type ToolPartByName<TName extends string> = Extract<
  AllToolParts,
  { name: TName }
>;

type ArgsOf<TName extends string> =
  ToolPartByName<TName> extends { parameters: infer P } ? P : never;

export type ToolRegistry = {
  Read: { args: ArgsOf<"Read">; result: string };
  Write: { args: ArgsOf<"Write">; result: string };
  Edit: { args: ArgsOf<"Edit">; result: string };
  MultiEdit: { args: ArgsOf<"MultiEdit">; result: string };
  Grep: { args: ArgsOf<"Grep">; result: string };
  Glob: { args: ArgsOf<"Glob">; result: string };
  LS: { args: ArgsOf<"LS">; result: string };
  Bash: { args: ArgsOf<"Bash">; result: string };
  TodoRead: { args: ArgsOf<"TodoRead">; result: string };
  TodoWrite: { args: ArgsOf<"TodoWrite">; result: string };
  NotebookRead: { args: ArgsOf<"NotebookRead">; result: string };
  NotebookEdit: { args: ArgsOf<"NotebookEdit">; result: string };
  Task: { args: ArgsOf<"Task">; result: string };
  WebFetch: { args: ArgsOf<"WebFetch">; result: string };
  WebSearch: { args: ArgsOf<"WebSearch">; result: string };
  SuggestFollowupTask: {
    args: ArgsOf<"SuggestFollowupTask">;
    result: string;
  };
  /**
   * Alias emitted by the MCP follow-up server. `tool-part.tsx` collapses it onto
   * `SuggestFollowupTask` for rendering; args are the same shape.
   */
  mcp__terry__SuggestFollowupTask: {
    args: ArgsOf<"SuggestFollowupTask">;
    result: string;
  };
  ExitPlanMode: { args: ArgsOf<"ExitPlanMode">; result: string };
  PermissionRequest: { args: ArgsOf<"PermissionRequest">; result: string };
  FileChange: { args: ArgsOf<"FileChange">; result: string };
  /**
   * Codex MCP wrapper. Daemon emits `{ server, tool, ...rest }` as parameters; the
   * renderer rewrites the name to `mcp__server__tool` before dispatching to
   * `DefaultTool`. Typed loosely because `...rest` is provider-specific JSON and
   * `MCPTool` is not part of the typed `AllToolParts` arms.
   */
  MCPTool: {
    args: { server?: string; tool?: string; [key: string]: unknown };
    result: string;
  };
};

export type ToolName = keyof ToolRegistry;
export type ToolArgs<T extends ToolName> = ToolRegistry[T]["args"];
/**
 * Every entry in `ToolRegistry` resolves to `result: string` (see file header
 * for rationale: daemon normalizes tool results to strings before persisting).
 * A generic `ToolResult<T>` would be a structural no-op that just resolves to
 * `string` for every `T`, so we expose the constant alias instead. Narrow per
 * entry if a specific tool ever surfaces structured results.
 */
export type ToolResult = string;
