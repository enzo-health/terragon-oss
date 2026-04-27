import { describe, expect, it } from "vitest";
import { buildCiSignalSnapshotFromCheckRuns } from "./handlers";

describe("buildCiSignalSnapshotFromCheckRuns", () => {
  it("returns null for empty input", () => {
    expect(buildCiSignalSnapshotFromCheckRuns([])).toBeNull();
  });

  it("treats all-success check runs as complete with no failures", () => {
    const snapshot = buildCiSignalSnapshotFromCheckRuns([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "success" },
    ]);
    expect(snapshot).toEqual({
      checkNames: ["build", "test"],
      failingChecks: [],
      complete: true,
    });
  });

  it("reports failing checks and keeps complete=true when all runs are completed", () => {
    const snapshot = buildCiSignalSnapshotFromCheckRuns([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "failure" },
    ]);
    expect(snapshot).toEqual({
      checkNames: ["build", "lint"],
      failingChecks: ["lint"],
      complete: true,
    });
  });

  it("returns complete=false when any non-self check is still in progress", () => {
    const snapshot = buildCiSignalSnapshotFromCheckRuns([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "in_progress", conclusion: null },
    ]);
    expect(snapshot?.complete).toBe(false);
  });

  describe("Terragon self-check exclusion", () => {
    // Regression guard for the runtime self-check deadlock: Terragon can
    // publish its own `in_progress` check while waiting on external CI. If the
    // aggregator counted it, Terragon would be waiting on itself.
    it("excludes the self-check (matched by name) when computing completeness — 20 green + 1 self=in_progress is complete+green", () => {
      const checkRuns: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        external_id?: string | null;
      }> = [];
      for (let i = 1; i <= 20; i += 1) {
        checkRuns.push({
          name: `ci-check-${i}`,
          status: "completed",
          conclusion: "success",
        });
      }
      checkRuns.push({
        name: "Terragon Delivery Loop",
        status: "in_progress",
        conclusion: null,
      });

      const snapshot = buildCiSignalSnapshotFromCheckRuns(checkRuns);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.complete).toBe(true);
      expect(snapshot?.failingChecks).toEqual([]);
      // The self-check must not appear in the reported check names either.
      expect(snapshot?.checkNames).not.toContain("Terragon Delivery Loop");
      expect(snapshot?.checkNames).toHaveLength(20);
    });

    it("excludes the self-check when matched by external_id prefix even if the name is customized", () => {
      const snapshot = buildCiSignalSnapshotFromCheckRuns([
        { name: "build", status: "completed", conclusion: "success" },
        {
          name: "Custom Delivery Loop Name",
          status: "in_progress",
          conclusion: null,
          external_id: "terragon-sdlc-loop-check-run:workflow-abc-123",
        },
      ]);
      expect(snapshot?.complete).toBe(true);
      expect(snapshot?.checkNames).toEqual(["build"]);
    });

    it("returns null when the only check run is the Terragon self-check", () => {
      // Prevents the staleness poll from falsely reporting "all green" when
      // the repo has no actual CI configured. `null` → keep polling, not
      // `complete=true`.
      const snapshot = buildCiSignalSnapshotFromCheckRuns([
        {
          name: "Terragon Delivery Loop",
          status: "in_progress",
          conclusion: null,
          external_id: "terragon-sdlc-loop-check-run:xyz",
        },
      ]);
      expect(snapshot).toBeNull();
    });
  });
});
