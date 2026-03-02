import { describe, expect, it, vi } from "vitest";
import { parsePlanSpec, normalizeStableTaskId } from "./parse-plan-spec";

// Mock the ai SDK's generateObject for LLM normalization tests
vi.mock("ai", () => ({
  generateObject: vi.fn(),
}));

// Mock the openai provider
vi.mock("@ai-sdk/openai", () => ({
  openai: vi.fn(() => "mocked-model"),
}));

import { generateObject } from "ai";
const mockedGenerateObject = vi.mocked(generateObject);

describe("parsePlanSpec", () => {
  describe("canonical format (strict parser)", () => {
    it("parses standard tasks/title/stableTaskId JSON", async () => {
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
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("setup-auth");
      expect(result.plan.tasks[0]!.title).toBe("Set up authentication module");
      expect(result.plan.tasks[0]!.description).toBe("Create auth middleware.");
      expect(result.plan.tasks[0]!.acceptance).toEqual(["Login returns JWT"]);
      expect(result.plan.planText).toBe("Set up auth module");
    });

    it("auto-generates stableTaskId from title if missing", async () => {
      const input = JSON.stringify({
        tasks: [{ title: "Add login page" }],
      });
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks[0]!.stableTaskId).toBe("add-login-page");
    });
  });

  describe("case insensitivity", () => {
    it("resolves canonical keys case-insensitively", async () => {
      const input = JSON.stringify({
        Tasks: [
          {
            Title: "Case test",
            StableTaskId: "case-test",
          },
        ],
      });
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks[0]!.title).toBe("Case test");
      expect(result.plan.tasks[0]!.stableTaskId).toBe("case-test");
    });
  });

  describe("nested JSON (1 level)", () => {
    it("parses { plan: { tasks: [...] } } format", async () => {
      const input = JSON.stringify({
        plan: {
          planText: "Overview of the plan",
          tasks: [
            { title: "Task A", description: "Do A" },
            { title: "Task B", description: "Do B" },
          ],
        },
      });
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
      expect(result.plan.planText).toBe("Overview of the plan");
      expect(result.diagnostic).toContain("root.plan");
    });
  });

  describe("top-level array", () => {
    it("parses [{ title: '...' }] format", async () => {
      const input = JSON.stringify([
        { title: "Task 1" },
        { title: "Task 2" },
        { title: "Task 3" },
      ]);
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(3);
      expect(result.diagnostic).toContain("top-level JSON array");
    });
  });

  describe("fenced JSON blocks", () => {
    it("extracts JSON from ```json fences with canonical keys", async () => {
      const input = [
        "Here is my plan:",
        "",
        "```json",
        JSON.stringify({
          tasks: [
            { title: "Write tests", stableTaskId: "write-tests" },
            { title: "Implement code", stableTaskId: "impl-code" },
          ],
        }),
        "```",
      ].join("\n");
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("write-tests");
      expect(result.plan.tasks[1]!.title).toBe("Implement code");
    });
  });

  describe("LLM normalization fallback", () => {
    it("triggers LLM normalization for non-canonical JSON", async () => {
      mockedGenerateObject.mockResolvedValueOnce({
        object: {
          planText: "Implement feature X",
          tasks: [
            {
              stableTaskId: "step-1",
              title: "Create database schema",
              description: "Add migrations for new tables.",
              acceptance: ["Migration runs without errors"],
            },
          ],
        },
        // Minimal mock shape for other fields
        response: { id: "test-response" },
      } as any);

      // Non-canonical: "steps" instead of "tasks", "task_name" instead of "title"
      const input = JSON.stringify({
        plan_text: "Implement feature X",
        steps: [
          {
            stableId: "step-1",
            task_name: "Create database schema",
            details: "Add migrations for new tables.",
            acceptance_criteria: ["Migration runs without errors"],
          },
        ],
      });
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(1);
      expect(result.plan.tasks[0]!.stableTaskId).toBe("step-1");
      expect(result.plan.tasks[0]!.title).toBe("Create database schema");
      expect(result.diagnostic).toContain("LLM");
      expect(mockedGenerateObject).toHaveBeenCalledOnce();
    });

    it("skips LLM for canonical JSON that parses successfully", async () => {
      mockedGenerateObject.mockClear();
      const input = JSON.stringify({
        tasks: [{ title: "Direct parse" }],
      });
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      expect(mockedGenerateObject).not.toHaveBeenCalled();
    });

    it("skips LLM for non-JSON input and falls through to markdown", async () => {
      mockedGenerateObject.mockClear();
      const input = [
        "Implementation plan:",
        "1. Set up database schema",
        "2. Create API endpoints",
      ].join("\n");
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
      expect(mockedGenerateObject).not.toHaveBeenCalled();
    });

    it("returns clean diagnostic when LLM normalization fails", async () => {
      mockedGenerateObject.mockRejectedValueOnce(new Error("LLM error"));

      const input = JSON.stringify({
        steps: [{ name: "Broken format" }],
      });
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain("could not be parsed or normalized");
    });
  });

  describe("markdown list fallback", () => {
    it("parses numbered list", async () => {
      const input = [
        "Implementation plan:",
        "1. Set up database schema",
        "2. Create API endpoints",
        "3. Build frontend components",
      ].join("\n");
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(3);
      expect(result.plan.tasks[0]!.title).toBe("Set up database schema");
      expect(result.plan.tasks[0]!.stableTaskId).toBe("task-1");
    });

    it("parses bullet list", async () => {
      const input = ["- Add auth middleware", "- Configure JWT tokens"].join(
        "\n",
      );
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
    });

    it("parses step-prefixed list", async () => {
      const input = [
        "Step 1: Initialize project",
        "Step 2: Add dependencies",
      ].join("\n");
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.plan.tasks).toHaveLength(2);
    });
  });

  describe("error cases", () => {
    it("returns diagnostic for empty text", async () => {
      const result = await parsePlanSpec("");
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toBe("Plan text is empty.");
    });

    it("returns diagnostic for whitespace-only text", async () => {
      const result = await parsePlanSpec("   \n\n  ");
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toBe("Plan text is empty.");
    });

    it("returns diagnostic when tasks array has no valid titles", async () => {
      mockedGenerateObject.mockRejectedValueOnce(new Error("mocked"));
      const input = JSON.stringify({
        tasks: [{ description: "No title here" }, { description: "Or here" }],
      });
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain("could not be parsed or normalized");
    });

    it("returns diagnostic for plain text without list structure", async () => {
      const input = "This is just a paragraph describing what I plan to do.";
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain("No JSON or structured list found");
    });

    it("returns diagnostic for top-level array with no titles", async () => {
      mockedGenerateObject.mockRejectedValueOnce(new Error("mocked"));
      const input = JSON.stringify([
        { description: "no title" },
        { foo: "also-no-title" },
      ]);
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(false);
      expect(result.diagnostic).toContain("could not be parsed or normalized");
    });
  });

  describe("strict parser — no cross-key aliasing", () => {
    it("does NOT parse 'steps' as tasks (requires LLM)", async () => {
      mockedGenerateObject.mockClear();
      mockedGenerateObject.mockRejectedValueOnce(new Error("mocked failure"));

      const input = JSON.stringify({
        steps: [{ name: "Should not parse directly" }],
      });
      const result = await parsePlanSpec(input);
      // Strict parser fails, LLM fallback fails → overall failure
      expect(result.ok).toBe(false);
    });

    it("does NOT parse 'name' as title (requires LLM)", async () => {
      mockedGenerateObject.mockClear();
      mockedGenerateObject.mockRejectedValueOnce(new Error("mocked failure"));

      const input = JSON.stringify({
        tasks: [{ name: "Should not match title" }],
      });
      const result = await parsePlanSpec(input);
      expect(result.ok).toBe(false);
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
