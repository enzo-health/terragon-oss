import { describe, expect, it } from "vitest";
import { parsePlanSpec, normalizeStableTaskId } from "./parse-plan-spec";

describe("parsePlanSpec", () => {
  describe("canonical format", () => {
    it("parses standard tasks/title/stableTaskId JSON", () => {
      const input = JSON.stringify({
        planText: "Set up auth module",
        tasks: [
          {
            stableTaskId: "setup-auth",
            title: "Set up authentication module",
            description: "Create auth middleware.",
            acceptance: ["Login returns JWT"],
          },
        ],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("setup-auth");
      expect(result.plan.tasks[0]!.title).toBe("Set up authentication module");
      expect(result.plan.tasks[0]!.description).toBe("Create auth middleware.");
      expect(result.plan.tasks[0]!.acceptance).toEqual(["Login returns JWT"]);
      expect(result.plan.planText).toBe("Set up auth module");
    });

    it("auto-generates stableTaskId from title if missing", () => {
      const input = JSON.stringify({
        tasks: [{ title: "Add login page" }],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks[0]!.stableTaskId).toBe("add-login-page");
    });
  });

  describe("agent alias formats", () => {
    it("parses steps/task_name/stableId aliases", () => {
      const input = JSON.stringify({
        summary: "Implement feature X",
        steps: [
          {
            stableId: "step-1",
            task_name: "Create database schema",
            details: "Add migrations for new tables.",
            acceptance_criteria: ["Migration runs without errors"],
          },
        ],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("step-1");
      expect(result.plan.tasks[0]!.title).toBe("Create database schema");
      expect(result.plan.tasks[0]!.description).toBe(
        "Add migrations for new tables.",
      );
      expect(result.plan.tasks[0]!.acceptance).toEqual([
        "Migration runs without errors",
      ]);
      expect(result.plan.planText).toBe("Implement feature X");
    });

    it("parses name/id aliases", () => {
      const input = JSON.stringify({
        tasks: [
          {
            id: "my-task",
            name: "Build API endpoint",
            desc: "REST endpoint for users.",
            criteria: ["Returns 200"],
          },
        ],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks[0]!.stableTaskId).toBe("my-task");
      expect(result.plan.tasks[0]!.title).toBe("Build API endpoint");
      expect(result.plan.tasks[0]!.description).toBe(
        "REST endpoint for users.",
      );
      expect(result.plan.tasks[0]!.acceptance).toEqual(["Returns 200"]);
    });

    it("parses items array alias", () => {
      const input = JSON.stringify({
        items: [{ label: "First item", detail: "Do the thing" }],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.title).toBe("First item");
    });
  });

  describe("case insensitivity", () => {
    it("resolves keys case-insensitively", () => {
      const input = JSON.stringify({
        Tasks: [
          {
            Title: "Case test",
            StableTaskId: "case-test",
          },
        ],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks[0]!.title).toBe("Case test");
      expect(result.plan.tasks[0]!.stableTaskId).toBe("case-test");
    });
  });

  describe("nested JSON (1 level)", () => {
    it("parses { plan: { tasks: [...] } } format", () => {
      const input = JSON.stringify({
        plan: {
          summary: "Overview of the plan",
          tasks: [
            { title: "Task A", description: "Do A" },
            { title: "Task B", description: "Do B" },
          ],
        },
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
      expect(result.plan.planText).toBe("Overview of the plan");
      expect(result.diagnostic).toContain("root.plan");
    });
  });

  describe("top-level array", () => {
    it("parses [{ title: '...' }] format", () => {
      const input = JSON.stringify([
        { title: "Task 1" },
        { title: "Task 2" },
        { title: "Task 3" },
      ]);
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(3);
      expect(result.diagnostic).toContain("top-level JSON array");
    });
  });

  describe("fenced JSON blocks", () => {
    it("extracts JSON from ```json fences", () => {
      const input = [
        "Here is my plan:",
        "",
        "```json",
        JSON.stringify({
          steps: [
            { name: "Write tests", stable_id: "write-tests" },
            { name: "Implement code", stable_id: "impl-code" },
          ],
        }),
        "```",
      ].join("\n");
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("write-tests");
      expect(result.plan.tasks[1]!.title).toBe("Implement code");
    });
  });

  describe("<proposed_plan> tags", () => {
    it("parses tasks from a proposed_plan markdown block", () => {
      const input = [
        "Some preface",
        "<proposed_plan>",
        "## Plan",
        "",
        "1. Build auth flow",
        "2. Add tests",
        "</proposed_plan>",
      ].join("\n");
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
      expect(result.plan.tasks[0]!.title).toBe("Build auth flow");
      expect(result.plan.tasks[1]!.title).toBe("Add tests");
      expect(result.diagnostic).toContain("<proposed_plan>");
    });
  });

  describe("markdown list fallback", () => {
    it("parses numbered list", () => {
      const input = [
        "Implementation plan:",
        "1. Set up database schema",
        "2. Create API endpoints",
        "3. Build frontend components",
      ].join("\n");
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(3);
      expect(result.plan.tasks[0]!.title).toBe("Set up database schema");
      expect(result.plan.tasks[0]!.stableTaskId).toBe("task-1");
    });

    it("parses bullet list", () => {
      const input = ["- Add auth middleware", "- Configure JWT tokens"].join(
        "\n",
      );
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
    });

    it("parses step-prefixed list", () => {
      const input = [
        "Step 1: Initialize project",
        "Step 2: Add dependencies",
      ].join("\n");
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
    });
  });

  describe("truncated JSON recovery", () => {
    it("recovers plan from unclosed fenced JSON block", () => {
      const input = [
        "Here is my plan:",
        "",
        "```json",
        '{ "tasks": [{ "title": "Set up auth", "stableTaskId": "setup-auth" }, { "title": "Add tests", "stableTaskId": "add-tests"',
      ].join("\n");
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Should recover at least the first complete task
      expect(result.plan.tasks.length).toBeGreaterThanOrEqual(1);
      expect(result.plan.tasks[0]!.title).toBe("Set up auth");
    });

    it("recovers plan from truncated bare JSON object", () => {
      const input =
        'Some preamble text\n{ "planText": "My plan", "tasks": [{ "title": "First task", "stableTaskId": "first" }';
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.title).toBe("First task");
    });

    it("recovers plan with truncated string value", () => {
      const input = [
        "```json",
        '{ "tasks": [{ "title": "Complete task", "stableTaskId": "complete" }, { "title": "Truncated desc',
      ].join("\n");
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks.length).toBeGreaterThanOrEqual(1);
      expect(result.plan.tasks[0]!.title).toBe("Complete task");
    });
  });

  describe("error cases", () => {
    it("returns diagnostic for empty text", () => {
      const result = parsePlanSpec("");
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toBe("Plan text is empty.");
    });

    it("returns diagnostic for whitespace-only text", () => {
      const result = parsePlanSpec("   \n\n  ");
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toBe("Plan text is empty.");
    });

    it("returns diagnostic when tasks array has no valid titles", () => {
      const input = JSON.stringify({
        tasks: [{ description: "No title here" }, { description: "Or here" }],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain("recognizable 'title' field");
    });

    it("returns diagnostic for JSON with no tasks array", () => {
      const input = JSON.stringify({ foo: "bar", baz: 123 });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain(
        "could not locate a tasks/steps array",
      );
    });

    it("returns diagnostic for plain text without list structure", () => {
      const input = "This is just a paragraph describing what I plan to do.";
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain("No JSON or structured list found");
    });

    it("returns diagnostic for top-level array with no titles", () => {
      const input = JSON.stringify([
        { description: "no title" },
        { id: "also-no-title" },
      ]);
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain(
        "top-level JSON array but no task had a recognizable 'title'",
      );
    });
  });

  describe("priority ordering", () => {
    it("canonical title wins over alias name", () => {
      const input = JSON.stringify({
        tasks: [{ title: "Canonical title", name: "Alias name" }],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks[0]!.title).toBe("Canonical title");
    });

    it("canonical stableTaskId wins over alias id", () => {
      const input = JSON.stringify({
        tasks: [
          { title: "Test", stableTaskId: "canonical-id", id: "alias-id" },
        ],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks[0]!.stableTaskId).toBe("canonical-id");
    });

    it("canonical tasks array wins over alias steps", () => {
      const input = JSON.stringify({
        tasks: [{ title: "From tasks" }],
        steps: [{ title: "From steps" }],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks[0]!.title).toBe("From tasks");
    });
  });

  describe("duplicate JSON block parsing (Codex double-output)", () => {
    it("deduplicates identical fenced JSON blocks separated by six-backtick boundary", () => {
      const block = JSON.stringify({
        planText: "test",
        tasks: [
          {
            stableTaskId: "t1",
            title: "Task 1",
            description: "desc",
            acceptance: ["done"],
          },
        ],
      });
      const input = [
        "Here is the plan:",
        "",
        "```json",
        block,
        "``````json",
        block,
        "```",
      ].join("\n");
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("t1");
    });

    it("handles six-backtick boundary with space between fences", () => {
      const block = JSON.stringify({
        planText: "test",
        tasks: [
          {
            stableTaskId: "t1",
            title: "Task 1",
            description: "desc",
            acceptance: ["done"],
          },
        ],
      });
      const input = ["```json", block, "```", "```json", block, "```"].join(
        "\n",
      );
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("t1");
    });

    it("uses first block when duplicate blocks have different content", () => {
      const block1 = JSON.stringify({
        planText: "first",
        tasks: [
          {
            stableTaskId: "t1",
            title: "First Task",
            description: "first desc",
            acceptance: ["first criterion"],
          },
        ],
      });
      const block2 = JSON.stringify({
        planText: "second",
        tasks: [
          {
            stableTaskId: "t2",
            title: "Second Task",
            description: "second desc",
            acceptance: ["second criterion"],
          },
        ],
      });
      const input = ["```json", block1, "``````json", block2, "```"].join("\n");
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("t1");
      expect(result.plan.tasks[0]!.title).toBe("First Task");
      expect(result.plan.planText).toBe("first");
    });
  });

  describe("no cross-field ambiguity", () => {
    it("summary resolves to planText, not task title", () => {
      const input = JSON.stringify({
        summary: "This is the plan summary",
        tasks: [{ title: "A task" }],
      });
      const result = parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.planText).toBe("This is the plan summary");
      expect(result.plan.tasks[0]!.title).toBe("A task");
    });
  });
});

describe("normalizeStableTaskId", () => {
  it("converts to lowercase kebab-case", () => {
    expect(normalizeStableTaskId("Setup Auth Module", 0)).toBe(
      "setup-auth-module",
    );
  });

  it("strips leading/trailing hyphens", () => {
    expect(normalizeStableTaskId("--test--", 0)).toBe("test");
  });

  it("falls back to task-N for empty result", () => {
    expect(normalizeStableTaskId("!!!", 2)).toBe("task-3");
  });
});
