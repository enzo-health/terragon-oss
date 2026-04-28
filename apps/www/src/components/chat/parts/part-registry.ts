/**
 * Part renderer registry — Phase 4 prep.
 *
 * Central typed dispatch table that maps every `UIPartExtended["type"]`
 * (the www-local extension of `DBAgentMessagePart["type"]` plus the
 * shared `UIPart` extras like `tool`, `pdf`, `text-file`, `rich-text`)
 * to its renderer component plus a typed `buildProps` adapter.
 *
 * # Why a per-component prop builder rather than a uniform `{ part }` shape?
 *
 * The renderers in this directory are NOT prop-uniform. A representative
 * sample of their signatures:
 *
 *   - `TextPart`   → `{ text, streaming, githubRepoFullName, branchName,
 *                       baseBranchName, hasCheckpoint, onOpenInArtifactWorkspace }`
 *   - `ImagePart`  → `{ imageUrl, alt?, onClick?, onOpenInArtifactWorkspace? }`
 *   - `PdfPart`    → `{ pdfUrl, filename, onOpenInArtifactWorkspace? }`
 *   - `TextFilePart` → `{ textFileUrl, filename, mimeType, onOpenInArtifactWorkspace? }`
 *   - `RichTextPart` → `{ richTextPart, onOpenInArtifactWorkspace? }`
 *   - `ThinkingPart` → `{ thinking, isLatest, isAgentWorking }`
 *   - `AudioPartView` / `TerminalPartView` / `ResourceLinkView` /
 *     `DiffPartView` / `AutoApprovalReviewCard` / `ServerToolUseView` /
 *     `WebSearchResultView` → `{ part }`
 *   - `PlanPartView` → `{ part: DBPlanPart }`  (used for both `plan` and
 *     `plan-structured` since both carry `entries`)
 *   - `DelegationItemCard` → `{ delegation: DBDelegationMessage }`
 *   - `ToolPart`   → handled separately below
 *
 * A uniform `{ part, ctx }` adapter would force every renderer either
 * (a) to accept the full context as a prop bag (leaking unrelated state
 * into pure leaves like `AudioPartView`) or (b) to be wrapped here and
 * lose direct testability. Instead we keep the renderers untouched and
 * encode the shape adaptation in `buildProps`.
 *
 * # Dispatch contract
 *
 * Each entry has the form `{ component, buildProps(ctx, part) }`:
 *
 *   - `component` is the React component to render.
 *   - `buildProps` is a pure function from
 *     `(PartRegistryContext, NarrowedPart) → ComponentProps<typeof component>`.
 *
 * `PartRegistryContext` carries everything a renderer might need that is
 * not on the part itself: the streaming flags, the artifact-workspace
 * handlers, the per-tool props bundle (`toolProps`), and the resolved
 * artifact descriptor for the current part. Phase 4 main will compute
 * `ctx` once in `message-part.tsx`'s render body and dispatch via:
 *
 *     const entry = PART_REGISTRY[part.type];
 *     const Cmp = entry.component;
 *     return <Cmp {...entry.buildProps(ctx, part)} />;
 *
 * # Two part types that don't render inline
 *
 *   - `plan` (the DBPlanPart variant): legacy behavior is "render nothing
 *     inline; the plan is shown via the artifact-workspace panel". We
 *     preserve that with a no-op renderer (`NullRenderer`) so the
 *     registry still has an entry and `Object.keys(PART_REGISTRY)` covers
 *     the union exhaustively (Phase 4's intermediate gate).
 *   - `tool` and `delegation` carry value beyond the part type itself.
 *     `tool` requires the full `ToolPartProps`; `delegation` may be a
 *     full `DBDelegationMessage` or a stub `{ type: "delegation", ... }`
 *     and selects between two renderers in the existing switch. Phase 4
 *     main will likely keep these two outside the registry or extend the
 *     entry shape. We register both for exhaustiveness; Phase 4 may
 *     specialize as needed.
 *
 * # Exhaustiveness
 *
 * The `PartRegistry` type is keyed by `UIPartExtended["type"]`. If a new
 * variant is added to `DBAgentMessagePart` (or `UIPartExtended`), this
 * file fails to type-check until an entry is added. That is the
 * type-level analogue of Phase 4's runtime gate
 * `Object.keys(PART_REGISTRY).length === union size`.
 */
import type { ComponentType } from "react";
import type {
  AllToolParts,
  DBAudioPart,
  DBAutoApprovalReviewPart,
  DBDelegationMessage,
  DBDiffPart,
  DBPlanPart,
  DBResourceLinkPart,
  DBServerToolUsePart,
  DBTerminalPart,
  DBWebSearchResultPart,
  UIImagePart,
  UIPdfPart,
  UIRichTextPart,
  UITextFilePart,
} from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";

import { TextPart } from "../text-part";
import { ThinkingPart } from "../thinking-part";
import { ImagePart } from "../image-part";
import { PdfPart } from "../pdf-part";
import { TextFilePart } from "../text-file-part";
import { RichTextPart } from "../rich-text-part";
import { AudioPartView } from "../audio-part-view";
import { ResourceLinkView } from "../resource-link-view";
import { TerminalPartView } from "../terminal-part-view";
import { DiffPartView } from "../diff-part";
import { AutoApprovalReviewCard } from "../auto-approval-review-card";
import { PlanPartView } from "../plan-part";
import { ServerToolUseView } from "../server-tool-use-view";
import { WebSearchResultView } from "../web-search-result-view";
import { DelegationItemCard } from "../delegation-item-card";
import { ToolPart, type ToolPartProps } from "../tool-part";
import type {
  UIPartExtended,
  UIDelegationPart,
  UIStructuredPlanPart,
} from "../ui-parts-extended";

// ─────────────────────────────────────────────────────────────────────────────
// Context
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything `buildProps` may need that is not carried on the part itself.
 * Mirrors the inputs to the existing switch in `message-part.tsx`.
 */
export interface PartRegistryContext {
  /** True when this part belongs to the latest message in the transcript. */
  isLatest: boolean;
  /** True when the agent is currently producing tokens. */
  isAgentWorking: boolean;
  /** Click handler — currently only consumed by `image`. */
  onClick?: () => void;
  /** Bundle of props forwarded to `ToolPart` (excluding the part itself). */
  toolProps: Omit<ToolPartProps, "toolPart">;
  /** All artifact descriptors for the surrounding message — needed by
   *  `ToolPart` so child tools can promote their own artifacts. */
  artifactDescriptors: ArtifactDescriptor[];
  /** Optional opener used by anything that has a corresponding artifact. */
  onOpenArtifact?: (artifactId: string) => void;

  // Resolved before dispatch so renderers don't re-derive them ─────────────
  /** Resolved artifact descriptor for this specific part, if any. */
  artifactDescriptor: Pick<ArtifactDescriptor, "id" | "part"> | null;
  /** Resolved opener for the artifact descriptor above, if any. */
  onOpenInArtifactWorkspace?: () => void;
  /** Resolved opener for plan artifacts referenced from `text` parts. */
  onOpenPlanArtifact?: () => void;

  // GitHub citation context for `text` parts ───────────────────────────────
  githubRepoFullName: string;
  branchName: string | null;
  baseBranchName: string;
  hasCheckpoint: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-variant narrowing helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Narrow a `UIPartExtended` to the variant for a given key in the registry. */
export type PartByType<K extends UIPartExtended["type"]> = Extract<
  UIPartExtended,
  { type: K }
>;

/**
 * Single registry entry: the component plus its prop builder.
 *
 * `Component` is the React component. `Part` is the narrowed part variant.
 */
export interface PartRegistryEntry<Part, Props> {
  component: ComponentType<Props>;
  buildProps: (ctx: PartRegistryContext, part: Part) => Props;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper for the `plan` no-op (artifact-workspace-only render)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `plan` (DBPlanPart) renders to `null` inline — the plan is surfaced via
 * the artifact-workspace secondary panel, not in the message stream. The
 * existing switch returns `null` for this case; we keep an entry so the
 * registry stays exhaustive over `UIPartExtended["type"]`.
 */
const NullRenderer: ComponentType<Record<string, never>> = () => null;

// ─────────────────────────────────────────────────────────────────────────────
// Registry type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full part registry. Keyed exhaustively by every variant in
 * `UIPartExtended["type"]`. Each entry's `Props` is the component's own
 * prop type — adding a new variant or changing a renderer's signature
 * breaks compilation here, by design.
 */
export interface PartRegistry {
  text: PartRegistryEntry<
    PartByType<"text">,
    React.ComponentProps<typeof TextPart>
  >;
  thinking: PartRegistryEntry<
    PartByType<"thinking">,
    React.ComponentProps<typeof ThinkingPart>
  >;
  tool: PartRegistryEntry<AllToolParts, React.ComponentProps<typeof ToolPart>>;
  image: PartRegistryEntry<UIImagePart, React.ComponentProps<typeof ImagePart>>;
  "rich-text": PartRegistryEntry<
    UIRichTextPart,
    React.ComponentProps<typeof RichTextPart>
  >;
  pdf: PartRegistryEntry<UIPdfPart, React.ComponentProps<typeof PdfPart>>;
  "text-file": PartRegistryEntry<
    UITextFilePart,
    React.ComponentProps<typeof TextFilePart>
  >;
  /** Inline render is suppressed; rendered in the artifact panel instead. */
  plan: PartRegistryEntry<DBPlanPart, Record<string, never>>;
  audio: PartRegistryEntry<
    DBAudioPart,
    React.ComponentProps<typeof AudioPartView>
  >;
  "resource-link": PartRegistryEntry<
    DBResourceLinkPart,
    React.ComponentProps<typeof ResourceLinkView>
  >;
  terminal: PartRegistryEntry<
    DBTerminalPart,
    React.ComponentProps<typeof TerminalPartView>
  >;
  diff: PartRegistryEntry<
    DBDiffPart,
    React.ComponentProps<typeof DiffPartView>
  >;
  "auto-approval-review": PartRegistryEntry<
    DBAutoApprovalReviewPart,
    React.ComponentProps<typeof AutoApprovalReviewCard>
  >;
  "plan-structured": PartRegistryEntry<
    UIStructuredPlanPart,
    React.ComponentProps<typeof PlanPartView>
  >;
  "server-tool-use": PartRegistryEntry<
    DBServerToolUsePart,
    React.ComponentProps<typeof ServerToolUseView>
  >;
  "web-search-result": PartRegistryEntry<
    DBWebSearchResultPart,
    React.ComponentProps<typeof WebSearchResultView>
  >;
  delegation: PartRegistryEntry<
    UIDelegationPart,
    React.ComponentProps<typeof DelegationItemCard>
  >;
}

/** Union of every supported part-type discriminator. */
export type PartType = keyof PartRegistry;

// ─────────────────────────────────────────────────────────────────────────────
// Compile-time exhaustiveness assertion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type-level guard that `PartType` covers every variant in
 * `UIPartExtended["type"]`. If a new variant is added to the union but no
 * registry entry is created, this assignment fails to type-check.
 *
 * NOTE: this is purely a compile-time check — the value side is never read.
 */
type _AssertPartTypeCoversUnion = UIPartExtended["type"] extends PartType
  ? true
  : never;
type _AssertPartRegistryHasNoExtras = PartType extends UIPartExtended["type"]
  ? true
  : never;
const _exhaustive: [
  _AssertPartTypeCoversUnion,
  _AssertPartRegistryHasNoExtras,
] = [true, true];
void _exhaustive;

// ─────────────────────────────────────────────────────────────────────────────
// Registrations
// ─────────────────────────────────────────────────────────────────────────────

export const PART_REGISTRY: PartRegistry = {
  text: {
    component: TextPart,
    buildProps: (ctx, part) => ({
      text: part.text,
      streaming: ctx.isLatest && ctx.isAgentWorking,
      githubRepoFullName: ctx.githubRepoFullName,
      branchName: ctx.branchName ?? undefined,
      baseBranchName: ctx.baseBranchName,
      hasCheckpoint: ctx.hasCheckpoint,
      onOpenInArtifactWorkspace: ctx.onOpenPlanArtifact,
    }),
  },

  thinking: {
    component: ThinkingPart,
    buildProps: (ctx, part) => ({
      thinking: part.thinking,
      isLatest: ctx.isLatest,
      isAgentWorking: ctx.isAgentWorking,
    }),
  },

  tool: {
    component: ToolPart,
    buildProps: (ctx, part) => ({
      toolPart: part,
      ...ctx.toolProps,
      artifactDescriptors: ctx.artifactDescriptors,
      onOpenArtifact: ctx.onOpenArtifact,
    }),
  },

  image: {
    component: ImagePart,
    buildProps: (ctx, part) => ({
      imageUrl: part.image_url,
      onClick: ctx.onClick,
      onOpenInArtifactWorkspace: ctx.onOpenInArtifactWorkspace,
    }),
  },

  "rich-text": {
    component: RichTextPart,
    buildProps: (ctx, part) => ({
      richTextPart: part,
      onOpenInArtifactWorkspace: ctx.onOpenInArtifactWorkspace,
    }),
  },

  pdf: {
    component: PdfPart,
    buildProps: (ctx, part) => ({
      pdfUrl: part.pdf_url,
      filename: part.filename,
      onOpenInArtifactWorkspace: ctx.onOpenInArtifactWorkspace,
    }),
  },

  "text-file": {
    component: TextFilePart,
    buildProps: (ctx, part) => ({
      textFileUrl: part.file_url,
      filename: part.filename,
      mimeType: part.mime_type,
      onOpenInArtifactWorkspace: ctx.onOpenInArtifactWorkspace,
    }),
  },

  plan: {
    // Suppressed inline — plan parts surface via the artifact-workspace
    // panel. See the file header for rationale.
    component: NullRenderer,
    buildProps: () => ({}),
  },

  audio: {
    component: AudioPartView,
    buildProps: (_ctx, part) => ({ part }),
  },

  "resource-link": {
    component: ResourceLinkView,
    buildProps: (_ctx, part) => ({ part }),
  },

  terminal: {
    component: TerminalPartView,
    buildProps: (_ctx, part) => ({ part }),
  },

  diff: {
    component: DiffPartView,
    buildProps: (_ctx, part) => ({ part }),
  },

  "auto-approval-review": {
    component: AutoApprovalReviewCard,
    buildProps: (_ctx, part) => ({ part }),
  },

  "plan-structured": {
    component: PlanPartView,
    // The structured-plan UI part already carries an `entries` array with
    // the same shape as `DBPlanPart`. `PlanPartView` accepts a
    // `DBPlanPart`-shaped argument, so we re-tag the discriminator.
    buildProps: (_ctx, part) => ({
      part: { type: "plan", entries: part.entries },
    }),
  },

  "server-tool-use": {
    component: ServerToolUseView,
    buildProps: (_ctx, part) => ({ part }),
  },

  "web-search-result": {
    component: WebSearchResultView,
    buildProps: (_ctx, part) => ({ part }),
  },

  delegation: {
    component: DelegationItemCard,
    // The existing switch handles two delegation shapes:
    //   - `DBDelegationMessage` (full payload)  → `<DelegationItemCard>`
    //   - `{ type: "delegation"; agentName; status; message }` (stub) →
    //     a small inline card
    // Phase 4 main will need to decide whether to (a) widen
    // `DelegationItemCard` to accept the stub, (b) keep a thin local
    // wrapper, or (c) split the registry entry. For now we register the
    // canonical renderer; the stub branch will need a follow-up.
    buildProps: (_ctx, part) => ({
      delegation: part as DBDelegationMessage,
    }),
  },
};
