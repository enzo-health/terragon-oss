/* @vitest-environment jsdom */

/**
 * Exhaustiveness + dispatch test for `PART_REGISTRY`.
 *
 * We assert two things:
 *
 * 1. Runtime keys of `PART_REGISTRY` cover every variant in
 *    `UIPartExtended["type"]` and contain no extras. The compile-time
 *    assertion in `part-registry.ts` already enforces this at the type
 *    level — this test is the runtime mirror so nobody can paper over a
 *    missing entry with an `as any`.
 *
 * 2. Dispatching a per-variant fixture through `renderPartFromRegistry`
 *    does not throw. We don't mount to the DOM (each renderer pulls in a
 *    different transitive subtree); we only call `render(ctx, part)` to
 *    invoke the `buildProps` adapter and `createElement`. That is enough
 *    to catch shape-mismatch crashes between the part and the adapter.
 *
 * Compile-time exhaustiveness assertions in `part-registry.ts` are
 * enforced by TypeScript itself (see the `_AssertPartTypeCoversUnion` /
 * `_AssertPartRegistryHasNoExtras` constants). No runtime mirror needed
 * for those — the type system enforces them.
 */
import { describe, expect, it } from "vitest";
import type { UIPartExtended } from "../ui-parts-extended";
import {
  PART_REGISTRY,
  renderPartFromRegistry,
  type PartRegistryContext,
  type PartType,
} from "./part-registry";

// Runtime fixture: every variant of `UIPartExtended["type"]`.
const EXPECTED_PART_TYPES: readonly PartType[] = [
  "text",
  "thinking",
  "tool",
  "image",
  "rich-text",
  "pdf",
  "text-file",
  "plan",
  "audio",
  "resource-link",
  "terminal",
  "diff",
  "auto-approval-review",
  "plan-structured",
  "server-tool-use",
  "web-search-result",
  "delegation",
  "delegation-stub",
] as const;

// Compile-time exhaustiveness mirror: if a new variant is added to
// `UIPartExtended` but not to the fixture, TypeScript flags this.
type _AssertExpectedCoversUnion =
  UIPartExtended["type"] extends (typeof EXPECTED_PART_TYPES)[number]
    ? true
    : never;
type _AssertExpectedHasNoExtras =
  (typeof EXPECTED_PART_TYPES)[number] extends UIPartExtended["type"]
    ? true
    : never;
const _exhaustive: [_AssertExpectedCoversUnion, _AssertExpectedHasNoExtras] = [
  true,
  true,
];
void _exhaustive;

// Minimal context for dispatch. The renderers we exercise here either
// ignore the context (audio / resource-link / terminal / diff / etc.) or
// only read fields we provide explicitly.
const ctx: PartRegistryContext = {
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
  },
  artifactDescriptors: [],
  artifactDescriptor: null,
  githubRepoFullName: "owner/repo",
  branchName: null,
  baseBranchName: "main",
  hasCheckpoint: false,
};

// Per-variant fixtures. Shapes pinned to the type definitions in
// packages/shared/src/db/db-message.ts and ui-messages.ts.
const PART_FIXTURES: { [K in PartType]: Extract<UIPartExtended, { type: K }> } =
  {
    text: { type: "text", text: "hi" },
    thinking: { type: "thinking", thinking: "..." },
    tool: {
      type: "tool",
      name: "Read",
      id: "tool-1",
      parameters: { file_path: "/x" },
      parts: [],
      agent: "claudeCode",
      status: "pending",
    },
    image: { type: "image", image_url: "data:," },
    "rich-text": { type: "rich-text", nodes: [{ type: "text", text: "hi" }] },
    pdf: { type: "pdf", pdf_url: "data:," },
    "text-file": { type: "text-file", file_url: "data:," },
    plan: { type: "plan", planText: "" },
    audio: { type: "audio", mimeType: "audio/wav" },
    "resource-link": { type: "resource-link", uri: "x", name: "x" },
    terminal: {
      type: "terminal",
      sandboxId: "s",
      terminalId: "t",
      chunks: [],
    },
    diff: { type: "diff", filePath: "/x", newContent: "", status: "pending" },
    "auto-approval-review": {
      type: "auto-approval-review",
      reviewId: "r",
      targetItemId: "i",
      riskLevel: "low",
      action: "x",
      status: "pending",
    },
    "plan-structured": { type: "plan-structured", entries: [] },
    "server-tool-use": {
      type: "server-tool-use",
      id: "s",
      name: "web_search",
      input: {},
    },
    "web-search-result": { type: "web-search-result", toolUseId: "s" },
    delegation: {
      type: "delegation",
      model: null,
      delegationId: "d",
      tool: "spawn",
      status: "running",
      senderThreadId: "t",
      receiverThreadIds: [],
      prompt: "",
      delegatedModel: "",
      agentsStates: {},
    },
    "delegation-stub": {
      type: "delegation-stub",
      id: "d",
      agentName: "agent",
      message: "msg",
      status: "running",
    },
  };

describe("PART_REGISTRY", () => {
  it("runtime keys match the union exactly", () => {
    expect(Object.keys(PART_REGISTRY).sort()).toEqual(
      [...EXPECTED_PART_TYPES].sort(),
    );
  });

  it("has 18 entries (one per UIPartExtended variant)", () => {
    expect(Object.keys(PART_REGISTRY)).toHaveLength(18);
  });

  it("dispatches each variant through renderPartFromRegistry without throwing", () => {
    for (const partType of EXPECTED_PART_TYPES) {
      const part = PART_FIXTURES[partType];
      expect(() => renderPartFromRegistry(ctx, part)).not.toThrow();
    }
  });
});
