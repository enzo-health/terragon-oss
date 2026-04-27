import { describe, expect, it } from "vitest";
import type { UIPart } from "@terragon/shared";
import type {
  ArtifactDescriptor,
  GitDiffArtifactDescriptor,
} from "@terragon/shared/db/artifact-descriptors";
import { isEqualArtifactList, isEqualPlanMap } from "./ctx-stability";

/**
 * Fixture helper so individual tests only specify the fields they care
 * about — the compare function only inspects id/kind/status/title/updatedAt.
 */
function makeArtifact(
  overrides: Partial<GitDiffArtifactDescriptor> & { id: string },
): ArtifactDescriptor {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "git-diff",
    title: overrides.title ?? "Current changes",
    status: overrides.status ?? "ready",
    part: overrides.part ?? { type: "git-diff", diff: "" },
    origin: overrides.origin ?? {
      type: "thread",
      threadId: "t1",
      field: "gitDiff",
    },
    ...(overrides.updatedAt !== undefined && {
      updatedAt: overrides.updatedAt,
    }),
    ...(overrides.summary !== undefined && { summary: overrides.summary }),
  } satisfies GitDiffArtifactDescriptor;
}

/**
 * Map keys are `UIPart` (by object identity). Tests only need the keys
 * to be stable references — any non-null object shape is sufficient.
 */
function makeKey(label: string): UIPart {
  return { type: "text", text: label } as unknown as UIPart;
}

describe("isEqualPlanMap", () => {
  it("treats two empty maps as equal", () => {
    expect(isEqualPlanMap(new Map(), new Map())).toBe(true);
  });

  it("returns true when same keys map to same values", () => {
    const k1 = makeKey("a");
    const k2 = makeKey("b");
    const a = new Map<UIPart, number>([
      [k1, 0],
      [k2, 1],
    ]);
    const b = new Map<UIPart, number>([
      [k1, 0],
      [k2, 1],
    ]);
    expect(isEqualPlanMap(a, b)).toBe(true);
  });

  it("returns false when sizes differ", () => {
    const k1 = makeKey("a");
    const a = new Map<UIPart, number>([[k1, 0]]);
    const b = new Map<UIPart, number>();
    expect(isEqualPlanMap(a, b)).toBe(false);
  });

  it("returns false when a value differs for the same key", () => {
    const k1 = makeKey("a");
    const a = new Map<UIPart, number>([[k1, 0]]);
    const b = new Map<UIPart, number>([[k1, 1]]);
    expect(isEqualPlanMap(a, b)).toBe(false);
  });

  it("returns false when key identities differ (Map keys are by object identity)", () => {
    const k1 = makeKey("a");
    const k2 = makeKey("a"); // same content, different reference
    const a = new Map<UIPart, number>([[k1, 0]]);
    const b = new Map<UIPart, number>([[k2, 0]]);
    expect(isEqualPlanMap(a, b)).toBe(false);
  });
});

describe("isEqualArtifactList", () => {
  it("treats two empty arrays as equal", () => {
    expect(isEqualArtifactList([], [])).toBe(true);
  });

  it("returns true for identical content in different arrays", () => {
    const a = [
      makeArtifact({ id: "1", updatedAt: "2026-01-01T00:00:00Z" }),
      makeArtifact({ id: "2", updatedAt: "2026-01-02T00:00:00Z" }),
    ];
    const b = [
      makeArtifact({ id: "1", updatedAt: "2026-01-01T00:00:00Z" }),
      makeArtifact({ id: "2", updatedAt: "2026-01-02T00:00:00Z" }),
    ];
    expect(a).not.toBe(b);
    expect(isEqualArtifactList(a, b)).toBe(true);
  });

  it("returns false when lengths differ", () => {
    const a = [makeArtifact({ id: "1" })];
    const b: ArtifactDescriptor[] = [];
    expect(isEqualArtifactList(a, b)).toBe(false);
  });

  it("returns false when an id differs at the same position", () => {
    const a = [makeArtifact({ id: "1" })];
    const b = [makeArtifact({ id: "2" })];
    expect(isEqualArtifactList(a, b)).toBe(false);
  });

  it("returns false when updatedAt differs", () => {
    const a = [makeArtifact({ id: "1", updatedAt: "2026-01-01T00:00:00Z" })];
    const b = [makeArtifact({ id: "1", updatedAt: "2026-01-02T00:00:00Z" })];
    expect(isEqualArtifactList(a, b)).toBe(false);
  });

  it("returns true when only summary differs (summary is intentionally excluded from the compare set)", () => {
    // The compare function only inspects id/kind/status/title/updatedAt.
    // Summary is a derived display string and is not part of the stability
    // key — changing it alone should NOT invalidate the downstream memo.
    const a = [
      makeArtifact({
        id: "1",
        updatedAt: "2026-01-01T00:00:00Z",
        summary: "+1 −0",
      }),
    ];
    const b = [
      makeArtifact({
        id: "1",
        updatedAt: "2026-01-01T00:00:00Z",
        summary: "+10 −5",
      }),
    ];
    expect(isEqualArtifactList(a, b)).toBe(true);
  });
});
