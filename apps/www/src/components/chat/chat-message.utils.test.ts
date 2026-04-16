import { describe, expect, it } from "vitest";
import type { AllToolParts, UITextPart } from "@terragon/shared";
import { groupParts } from "./chat-message.utils";
import type { UIUserOrAgentPart } from "./chat-message.types";

function text(s: string): UITextPart {
  return { type: "text", text: s };
}

function bashTool(id: string): AllToolParts {
  return {
    type: "tool",
    id,
    agent: "claudeCode",
    name: "Bash",
    parameters: { command: "echo hi", description: "say hi" },
    parts: [],
    status: "completed",
    result: "hi\n",
  };
}

function readTool(id: string): AllToolParts {
  return {
    type: "tool",
    id,
    agent: "claudeCode",
    name: "Read",
    parameters: { file_path: "/tmp/x" },
    parts: [],
    status: "completed",
    result: "contents",
  };
}

describe("groupParts", () => {
  it("active turn: no parts are hidden behind collapsible-agent-activity", () => {
    const parts: UIUserOrAgentPart[] = [
      bashTool("a"),
      readTool("b"),
      text("Intermediate note"),
      bashTool("c"),
      text("Final answer"),
    ];

    const groups = groupParts({ parts, isActiveTurn: true });

    // Critical assertion: during the active turn, NOTHING is collapsed.
    // Consecutive parts of the same discriminant may merge into one group
    // (an artifact of the grouping loop), but none of them is the
    // `collapsible-agent-activity` type that hides content behind an
    // expander.
    for (const group of groups) {
      expect(group.type).not.toBe("collapsible-agent-activity");
    }

    // Every input part is still rendered somewhere in the output, in order.
    const flattened = groups.flatMap((g) => g.parts);
    expect(flattened).toEqual(parts);
  });

  it("historical turn: pre-final-text parts collapse into one collapsible-agent-activity group", () => {
    const parts: UIUserOrAgentPart[] = [
      bashTool("a"),
      readTool("b"),
      text("Intermediate note"),
      bashTool("c"),
      text("Final answer"),
    ];

    const groups = groupParts({ parts, isActiveTurn: false });

    const collapsibleGroups = groups.filter(
      (g) => g.type === "collapsible-agent-activity",
    );
    // Pre-final-text activity is collapsed under one expander. The "last
    // text part" rule only exempts parts AT OR AFTER the final text, so
    // bash(3) — which sits before the final text(4) — also collapses.
    expect(collapsibleGroups).toHaveLength(1);

    const collapsedParts = collapsibleGroups[0]!.parts;
    expect(collapsedParts).toEqual([parts[0], parts[1], parts[2], parts[3]]);

    // Only the final text remains as its own visible group.
    const lastGroup = groups[groups.length - 1]!;
    expect(lastGroup.type).toBe("text");
    expect(lastGroup.parts).toEqual([parts[4]]);
  });

  it("historical turn + only tool parts (no text): pre-final tools still collapse", () => {
    const parts: UIUserOrAgentPart[] = [
      bashTool("a"),
      readTool("b"),
      bashTool("c"),
    ];

    const groups = groupParts({ parts, isActiveTurn: false });

    const collapsibleGroups = groups.filter(
      (g) => g.type === "collapsible-agent-activity",
    );
    // First two tools collapse; the last part (index 2) always stays
    // expanded as its own group so the most recent content is visible.
    expect(collapsibleGroups).toHaveLength(1);
    expect(collapsibleGroups[0]!.parts).toHaveLength(2);
    expect(collapsibleGroups[0]!.parts[0]).toBe(parts[0]);
    expect(collapsibleGroups[0]!.parts[1]).toBe(parts[1]);

    const lastGroup = groups[groups.length - 1]!;
    expect(lastGroup.type).toBe("tool");
    expect(lastGroup.parts).toEqual([parts[2]]);
  });

  it("active turn + only tool parts (no text yet): all tools stay visible, no collapse", () => {
    const parts: UIUserOrAgentPart[] = [
      bashTool("a"),
      readTool("b"),
      bashTool("c"),
    ];

    const groups = groupParts({ parts, isActiveTurn: true });

    // No group hides content — all tools remain visible (they may be
    // lumped into a single "tool" group by the merge-consecutive loop,
    // but nothing is behind the "Finished working" expander).
    for (const group of groups) {
      expect(group.type).not.toBe("collapsible-agent-activity");
    }
    const flattened = groups.flatMap((g) => g.parts);
    expect(flattened).toEqual(parts);
  });

  it("supersession: same parts flip from expanded (active) to collapsed (historical) with no other input", () => {
    // This is the delta that Blocker 3 cares about: when a newer agent
    // message takes over (or the user sends a follow-up), the ONLY thing
    // that changes for the previous agent message is its `isActiveTurn`
    // input — and that alone must drive the collapse.
    const parts: UIUserOrAgentPart[] = [
      bashTool("a"),
      text("Intermediate"),
      bashTool("b"),
      text("Final"),
    ];

    const activeGroups = groupParts({ parts, isActiveTurn: true });
    const historicalGroups = groupParts({ parts, isActiveTurn: false });

    expect(
      activeGroups.some((g) => g.type === "collapsible-agent-activity"),
    ).toBe(false);
    expect(
      historicalGroups.some((g) => g.type === "collapsible-agent-activity"),
    ).toBe(true);
  });
});
