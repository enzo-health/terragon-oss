/**
 * Typed map of tool name to `{ args, result }` for the assistant-ui tool layer.
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
 * - `result` is the daemon's tool-result payload. Most completed tool calls are
 *   persisted as `UICompletedToolPart.result: string` (ui-messages.ts:183), but
 *   assistant-ui live tool calls can carry structured JSON before persistence.
 *   Keep structured results scoped to individual entries — do not widen the
 *   whole map.
 *
 * Tools tracked here mirror `TOOL_DISPATCH` in
 * `apps/www/src/components/chat/tool-part.tsx`. Two non-obvious entries:
 *
 *   - `MCPTool`: Codex emits `{ name: "MCPTool", parameters: { server, tool, ... } }`.
 *     The renderer rewrites the name to `mcp__server__tool` before falling through
 *     to `DefaultTool`. We type the registry entry as the raw daemon shape since
 *     `MCPTool` is not in `AllToolParts`.
 *   - `mcp__terry__SuggestFollowupTask`: alias the renderer collapses onto
 *     `SuggestFollowupTask`. Both names route to the same component with the same
 *     args, so we mirror them in the registry.
 *
 * The trailing `UIToolPart<string, Record<string, unknown>>`-style arm of
 * `AllToolParts` (the "unknown tool" fallback rendered by `DefaultTool`) is
 * intentionally NOT in the registry: by definition there is no compile-time
 * name for it. `DefaultTool` accepts the raw `parameters` JSON.
 */

import type { ReactNode } from "react";
import type { AllToolParts, UIMessage } from "@terragon/shared";
import type { ChildThreadInfo } from "@terragon/shared/db/types";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import type { ArtifactDescriptorLookup } from "../secondary-panel-helpers";

export const FILE_CHANGE_DIFF_RESULT_TYPE = "terragon.diff";

export type FileChangeDiffToolResult = {
  type: typeof FILE_CHANGE_DIFF_RESULT_TYPE;
  part: {
    type: "diff";
    filePath: string;
    oldContent?: string;
    newContent: string;
    unifiedDiff?: string;
    status: "pending" | "applied" | "rejected";
  };
};

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
  FileChange: {
    args: ArgsOf<"FileChange">;
    result: string | FileChangeDiffToolResult;
  };
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
export type ToolResult<T extends ToolName = ToolName> =
  ToolRegistry[T]["result"];

export const TOOL_NAMES = [
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
] as const satisfies readonly ToolName[];

type _AssertToolNamesCoverRegistry =
  ToolName extends (typeof TOOL_NAMES)[number] ? true : never;
type _AssertToolNamesHaveNoExtras = (typeof TOOL_NAMES)[number] extends ToolName
  ? true
  : never;
const _toolNamesAreExhaustive: [
  _AssertToolNamesCoverRegistry,
  _AssertToolNamesHaveNoExtras,
] = [true, true];
void _toolNamesAreExhaustive;

export type PermissionMode = "allowAll" | "plan";

export type ToolCapability =
  | { kind: "basic"; toolPart: AllToolParts }
  | { kind: "threadAccess"; threadId: string; threadChatId: string }
  | { kind: "childThreads"; childThreads: ChildThreadInfo[] }
  | {
      kind: "permissionMode";
      mode: PermissionMode;
      onUpdate: (mode: PermissionMode) => void;
    }
  | { kind: "githubContext"; repoFullName: string; repoBaseBranchName: string }
  | { kind: "messagesRef"; messagesRef: { current: UIMessage[] } }
  | { kind: "readOnly"; isReadOnly: boolean }
  | {
      kind: "artifactAccess";
      artifactDescriptors: ArtifactDescriptor[];
      artifactDescriptorLookup?: ArtifactDescriptorLookup;
      onOpenArtifact?: (artifactId: string) => void;
    }
  | {
      kind: "renderChild";
      renderChildToolPart: (childToolPart: AllToolParts) => ReactNode;
    };

/**
 * Narrow helper: extract a specific capability from the array by kind.
 * Throws if the capability is not present (callers should only request
 * capabilities they declared in TOOL_CAPABILITY_REQUIREMENTS).
 */
export function getCapability<K extends ToolCapability["kind"]>(
  capabilities: ToolCapability[],
  kind: K,
): Extract<ToolCapability, { kind: K }> {
  const cap = capabilities.find(
    (c): c is Extract<ToolCapability, { kind: K }> => c.kind === kind,
  );
  if (!cap) {
    throw new Error(`Missing required capability: ${kind}`);
  }
  return cap;
}

/**
 * Declares which capabilities each tool requires. Tools not listed here
 * default to `["basic"]` (simple tools that only need their toolPart).
 */
export const TOOL_CAPABILITY_REQUIREMENTS: {
  readonly [N in ToolName]?: readonly ToolCapability["kind"][];
} = {
  Task: ["basic", "renderChild"],
  SuggestFollowupTask: [
    "basic",
    "threadAccess",
    "childThreads",
    "githubContext",
  ],
  mcp__terry__SuggestFollowupTask: [
    "basic",
    "threadAccess",
    "childThreads",
    "githubContext",
  ],
  ExitPlanMode: ["basic", "messagesRef", "artifactAccess"],
  PermissionRequest: ["basic", "threadAccess", "readOnly"],
} as const;

const _defaultCapabilities: readonly ToolCapability["kind"][] = ["basic"];

export function getToolCapabilities(
  name: ToolName,
): readonly ToolCapability["kind"][] {
  return TOOL_CAPABILITY_REQUIREMENTS[name] ?? _defaultCapabilities;
}

const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

export function isToolName(name: string): name is ToolName {
  return TOOL_NAME_SET.has(name);
}
