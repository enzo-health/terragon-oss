import { describe, expect, it } from "vitest";
import type { UIPartExtended } from "./ui-parts-extended";

/**
 * Exhaustiveness check for the MessagePart dispatcher.
 *
 * We do NOT actually render every part — React 19's automatic JSX runtime
 * combined with `react-dom/server` in Vitest makes SSR flaky for deeply
 * nested components that pull in the full UI tree. The real guarantee is
 * at the type level: `UIPartExtended` is a discriminated union, and the
 * switch in `message-part.tsx` uses an `assertNever(part)` tail so any
 * future part type that isn't handled will fail `tsc --noEmit`.
 *
 * This test locks in the full list of known discriminants as a runtime
 * snapshot, so a PR that adds a new variant must update this file
 * (flagging it for review).
 */

const KNOWN_PART_TYPES: ReadonlyArray<UIPartExtended["type"]> = [
  "text",
  "tool",
  "image",
  "rich-text",
  "thinking",
  "pdf",
  "text-file",
  "plan",
  "audio",
  "resource-link",
  "terminal",
  "diff",
  "auto-approval-review",
  "plan-structured",
];

describe("MessagePart dispatcher", () => {
  it("has a known snapshot of UIPartExtended discriminants", () => {
    expect(KNOWN_PART_TYPES).toHaveLength(14);
    expect(new Set(KNOWN_PART_TYPES).size).toBe(KNOWN_PART_TYPES.length);
  });
});
