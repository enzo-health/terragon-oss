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
import { createElement, type ComponentType, type ReactElement } from "react";
import type {
  AllToolParts,
  DBAudioPart,
  DBAutoApprovalReviewPart,
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
  UIDelegationStubPart,
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
 *
 * `render` is a closed-over dispatcher that ties `component` and `buildProps`
 * together at *definition* time. Exposing only `render` at the dispatch
 * boundary lets us keep a uniform `(ctx, part) => ReactElement` signature in
 * the registry's index type — TypeScript can't otherwise correlate the
 * per-K Component and Props post-distribution. Construction goes through
 * `definePartEntry` so callers never wire `render` themselves.
 */
export interface PartRegistryEntry<Part, Props> {
  component: ComponentType<Props>;
  buildProps: (ctx: PartRegistryContext, part: Part) => Props;
  /** Dispatcher closed over the typed component+buildProps pair. */
  render: (ctx: PartRegistryContext, part: Part) => ReactElement;
}

/**
 * Construct a `PartRegistryEntry` and synthesize its `render` dispatcher.
 * Keeping the wiring inside this helper preserves the strict per-K typing
 * (Component props === buildProps return) without forcing every call site
 * to repeat the boilerplate.
 *
 * `Props` is inferred *only* from the `component` parameter (the
 * `NoInfer<Props>` wrapper on `buildProps` blocks bidirectional inference).
 * That avoids the trap where a builder returning `{ filename: string |
 * undefined }` would otherwise widen `Props` and decouple it from the
 * component's `{ filename?: string }` declaration.
 */
function definePartEntry<Props extends object, Part>(
  component: ComponentType<Props>,
  buildProps: (ctx: PartRegistryContext, part: Part) => NoInfer<Props>,
): PartRegistryEntry<Part, Props> {
  return {
    component,
    buildProps,
    render: (ctx, part) => createElement(component, buildProps(ctx, part)),
  };
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

/**
 * Inline fallback card for `UIDelegationStubPart`. Mirrors the markup the
 * old switch in `message-part.tsx` rendered for stub-shaped delegations
 * before the union was split. Kept in this file so the registry remains the
 * single source of truth for part dispatch — moving it elsewhere would just
 * re-introduce a special-case branch in `message-part.tsx`.
 */
const DelegationStubCard: ComponentType<{ part: UIDelegationStubPart }> = ({
  part,
}) =>
  createElement(
    "div",
    { className: "rounded-lg border border-border bg-muted/30 p-3 text-sm" },
    createElement(
      "div",
      { className: "font-medium" },
      `Delegated to ${part.agentName}`,
    ),
    createElement(
      "div",
      { className: "mt-1 text-xs text-muted-foreground" },
      part.status,
    ),
    createElement(
      "p",
      { className: "mt-2 whitespace-pre-wrap text-sm" },
      part.message,
    ),
  );

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
  /**
   * Stub variant — rendered inline as a small fallback card. See
   * `UIDelegationStubPart` for rationale on why this is a separate
   * discriminator from `delegation`. The dispatcher uses a tiny inline
   * component so the registry stays the single source of truth and
   * `message-part.tsx` doesn't need a special-case branch.
   */
  "delegation-stub": PartRegistryEntry<
    UIDelegationStubPart,
    { part: UIDelegationStubPart }
  >;
}

/** Union of every supported part-type discriminator. */
export type PartType = keyof PartRegistry;

// ─────────────────────────────────────────────────────────────────────────────
// Compile-time exhaustiveness assertion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Type-level guard that `PartType` covers every variant in
 * `UIPartExtended["type"]` (and vice versa). If a new variant is added to
 * the union but no registry entry is created, this assignment fails to
 * type-check at the `Assert<...>` site rather than at a downstream
 * dispatch call — TypeScript reports "Type 'false' does not satisfy the
 * constraint 'true'", which points directly at the failing arm.
 *
 * NOTE: this is purely a compile-time check — the value side is never read.
 */
type Assert<T extends true> = T;
type _AssertPartTypeCoversUnion = Assert<
  UIPartExtended["type"] extends PartType ? true : false
>;
type _AssertPartRegistryHasNoExtras = Assert<
  PartType extends UIPartExtended["type"] ? true : false
>;
// Reference both aliases so `noUnusedLocals` keeps them live.
type _ExhaustivenessGuards = [
  _AssertPartTypeCoversUnion,
  _AssertPartRegistryHasNoExtras,
];
const _exhaustivenessGuards: _ExhaustivenessGuards = [true, true];
void _exhaustivenessGuards;

// ─────────────────────────────────────────────────────────────────────────────
// Registrations
// ─────────────────────────────────────────────────────────────────────────────

export const PART_REGISTRY: PartRegistry = {
  text: definePartEntry(TextPart, (ctx, part) => ({
    text: part.text,
    streaming: ctx.isLatest && ctx.isAgentWorking,
    githubRepoFullName: ctx.githubRepoFullName,
    branchName: ctx.branchName ?? undefined,
    baseBranchName: ctx.baseBranchName,
    hasCheckpoint: ctx.hasCheckpoint,
    onOpenInArtifactWorkspace: ctx.onOpenPlanArtifact,
  })),

  thinking: definePartEntry(ThinkingPart, (ctx, part) => ({
    thinking: part.thinking,
    isLatest: ctx.isLatest,
    isAgentWorking: ctx.isAgentWorking,
  })),

  tool: definePartEntry(ToolPart, (ctx, part) => ({
    toolPart: part,
    ...ctx.toolProps,
    artifactDescriptors: ctx.artifactDescriptors,
    onOpenArtifact: ctx.onOpenArtifact,
  })),

  image: definePartEntry(ImagePart, (ctx, part) => ({
    imageUrl: part.image_url,
    onClick: ctx.onClick,
    onOpenInArtifactWorkspace: ctx.onOpenInArtifactWorkspace,
  })),

  "rich-text": definePartEntry(RichTextPart, (ctx, part) => ({
    richTextPart: part,
    onOpenInArtifactWorkspace: ctx.onOpenInArtifactWorkspace,
  })),

  pdf: definePartEntry(PdfPart, (ctx, part) => ({
    pdfUrl: part.pdf_url,
    filename: part.filename,
    onOpenInArtifactWorkspace: ctx.onOpenInArtifactWorkspace,
  })),

  "text-file": definePartEntry(TextFilePart, (ctx, part) => ({
    textFileUrl: part.file_url,
    filename: part.filename,
    mimeType: part.mime_type,
    onOpenInArtifactWorkspace: ctx.onOpenInArtifactWorkspace,
  })),

  // Suppressed inline — plan parts surface via the artifact-workspace
  // panel. See the file header for rationale.
  plan: definePartEntry(NullRenderer, () => ({})),

  audio: definePartEntry(AudioPartView, (_ctx, part) => ({ part })),

  "resource-link": definePartEntry(ResourceLinkView, (_ctx, part) => ({
    part,
  })),

  terminal: definePartEntry(TerminalPartView, (_ctx, part) => ({ part })),

  diff: definePartEntry(DiffPartView, (_ctx, part) => ({ part })),

  "auto-approval-review": definePartEntry(
    AutoApprovalReviewCard,
    (_ctx, part) => ({ part }),
  ),

  // The structured-plan UI part already carries an `entries` array with
  // the same shape as `DBPlanPart`. `PlanPartView` accepts a
  // `DBPlanPart`-shaped argument, so we re-tag the discriminator.
  "plan-structured": definePartEntry(PlanPartView, (_ctx, part) => ({
    part: { type: "plan", entries: part.entries },
  })),

  "server-tool-use": definePartEntry(ServerToolUseView, (_ctx, part) => ({
    part,
  })),

  "web-search-result": definePartEntry(WebSearchResultView, (_ctx, part) => ({
    part,
  })),

  // The two delegation shapes now have separate discriminators
  // (`delegation` vs `delegation-stub`) so each entry's prop builder is
  // sound — no `as DBDelegationMessage` cast needed. See
  // `UIDelegationStubPart` in `ui-parts-extended.ts` for the rationale.
  delegation: definePartEntry(DelegationItemCard, (_ctx, part) => ({
    delegation: part,
  })),

  "delegation-stub": definePartEntry(DelegationStubCard, (_ctx, part) => ({
    part,
  })),
};

// ─────────────────────────────────────────────────────────────────────────────
// Typed dispatch helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the registry entry for `part` against `ctx`. Co-locating the
 * dispatcher with the registry is what lets TypeScript preserve the
 * per-variant K → Part → Props correlation: each entry's `render` field
 * closes over its own typed `component` + `buildProps` pair, so the strict
 * pairing is enforced inside the entry rather than at the call site.
 *
 * Strict component / buildProps typing is preserved at registration time
 * via `definePartEntry`; the registry's exhaustiveness assertion above
 * guarantees every `UIPartExtended` variant has an entry.
 */
export function renderPartFromRegistry(
  ctx: PartRegistryContext,
  part: UIPartExtended,
): ReactElement {
  // Each entry's `render` closes over its own typed `component` + `buildProps`
  // pair (see `definePartEntry`). At this dispatch site `PART_REGISTRY[part.type]`
  // is still a union of entries, so `entry.render` is contravariant in its
  // `Part` parameter — TypeScript intersects the per-arm Part types to
  // `never`. The dispatch is sound at runtime (the discriminator is the
  // registry key), so we widen the call boundary once via a typed
  // `RenderFn` alias. No erasure of component or props types: the strict
  // pairing is preserved inside each entry's closure.
  type RenderFn = (
    ctx: PartRegistryContext,
    part: UIPartExtended,
  ) => ReactElement;
  // Defense-in-depth at the typed-cast boundary: the compile-time
  // exhaustiveness assertion above guarantees every union variant has an
  // entry, but bad data (e.g. an unknown variant slipping in via JSON
  // deserialization or a stale persisted part) would otherwise cause a
  // confusing `undefined.render is not a function` failure deep in React's
  // commit phase. Throw a clear error here instead.
  const entry = PART_REGISTRY[part.type];
  if (!entry) {
    throw new Error(
      `renderPartFromRegistry: unknown part type ${JSON.stringify(
        (part as { type?: string }).type,
      )}`,
    );
  }
  const render = entry.render as RenderFn;
  return render(ctx, part);
}
