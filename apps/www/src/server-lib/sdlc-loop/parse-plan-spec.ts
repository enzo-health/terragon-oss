/**
 * Strict canonical JSON plan parser with LLM normalization fallback.
 *
 * Phase 1: Strict parser — only accepts exact canonical keys (case-insensitive).
 * Phase 2: LLM normalization — uses generateObject to convert non-canonical JSON.
 * Phase 3: Markdown list fallback for unstructured text.
 */

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import * as z from "zod/v4";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedPlanTask = {
  stableTaskId: string;
  title: string;
  description: string | null;
  acceptance: string[];
};

export type ParsedPlanSpec = {
  planText: string;
  tasks: ParsedPlanTask[];
};

export type PlanParseResult =
  | { ok: true; plan: ParsedPlanSpec; diagnostic: string }
  | { ok: false; plan: null; diagnostic: string };

// ---------------------------------------------------------------------------
// LLM normalization schema
// ---------------------------------------------------------------------------

const planSpecSchema = z.object({
  planText: z.string().describe("Brief summary of the implementation approach"),
  tasks: z
    .array(
      z.object({
        stableTaskId: z.string().describe("Kebab-case unique ID for this task"),
        title: z.string().describe("Short imperative title for the task"),
        description: z
          .string()
          .nullable()
          .describe("Detailed description of what to do"),
        acceptance: z
          .array(z.string())
          .describe("Acceptance criteria for this task"),
      }),
    )
    .min(1),
});

// ---------------------------------------------------------------------------
// Stable task ID normalizer (shared with approve-plan & checkpoint)
// ---------------------------------------------------------------------------

export function normalizeStableTaskId(value: string, index: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return `task-${index + 1}`;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Strict canonical key resolver — case-insensitive but NO cross-key aliasing
// ---------------------------------------------------------------------------

function resolveStrictKey(
  obj: Record<string, unknown>,
  canonicalKey: string,
): unknown | undefined {
  const lowerTarget = canonicalKey.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lowerTarget) return obj[k];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Single-task parser (strict canonical keys only)
// ---------------------------------------------------------------------------

function parseTask(raw: unknown, index: number): ParsedPlanTask | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const titleRaw = resolveStrictKey(obj, "title");
  if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) return null;

  const title = titleRaw.trim();

  const idRaw = resolveStrictKey(obj, "stableTaskId");
  const stableTaskId =
    typeof idRaw === "string" && idRaw.trim().length > 0
      ? idRaw.trim()
      : normalizeStableTaskId(title, index);

  const descRaw = resolveStrictKey(obj, "description");
  const description =
    typeof descRaw === "string" && descRaw.trim().length > 0
      ? descRaw.trim()
      : null;

  const acceptanceRaw = resolveStrictKey(obj, "acceptance");
  const acceptance = Array.isArray(acceptanceRaw)
    ? acceptanceRaw
        .filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0,
        )
        .map((c) => c.trim())
    : [];

  return { stableTaskId, title, description, acceptance };
}

// ---------------------------------------------------------------------------
// JSON tree walker — finds tasks array up to 1 level of nesting
// ---------------------------------------------------------------------------

function parseJsonObject(root: unknown, rawText: string): PlanParseResult {
  // Tier A: top-level array → treat as tasks directly
  if (Array.isArray(root)) {
    const tasks = root
      .map((item, i) => parseTask(item, i))
      .filter((t): t is ParsedPlanTask => t !== null);
    if (tasks.length === 0) {
      return {
        ok: false,
        plan: null,
        diagnostic:
          "Found top-level JSON array but no task had a recognizable 'title' field.",
      };
    }
    return {
      ok: true,
      plan: { planText: rawText, tasks },
      diagnostic: `Found top-level JSON array — ${tasks.length} task(s) parsed successfully.`,
    };
  }

  if (!root || typeof root !== "object") {
    return {
      ok: false,
      plan: null,
      diagnostic: "Parsed JSON is not an object or array.",
    };
  }

  const obj = root as Record<string, unknown>;

  // Tier B: strict "tasks" key at root level
  const tasksRaw = resolveStrictKey(obj, "tasks");
  if (Array.isArray(tasksRaw)) {
    const tasks = tasksRaw
      .map((item, i) => parseTask(item, i))
      .filter((t): t is ParsedPlanTask => t !== null);
    const planTextRaw = resolveStrictKey(obj, "planText");
    const planText =
      typeof planTextRaw === "string" && planTextRaw.trim().length > 0
        ? planTextRaw.trim()
        : rawText;
    if (tasks.length === 0) {
      return {
        ok: false,
        plan: null,
        diagnostic:
          "Found JSON with tasks array but no task had a recognizable 'title' field.",
      };
    }
    return {
      ok: true,
      plan: { planText, tasks },
      diagnostic: `Found JSON with tasks at root — ${tasks.length} task(s) parsed successfully.`,
    };
  }

  // Tier C: check one level of nesting for "tasks" key
  for (const key of Object.keys(obj)) {
    const nested = obj[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested))
      continue;
    const nestedObj = nested as Record<string, unknown>;
    const nestedTasks = resolveStrictKey(nestedObj, "tasks");
    if (Array.isArray(nestedTasks)) {
      const tasks = nestedTasks
        .map((item, i) => parseTask(item, i))
        .filter((t): t is ParsedPlanTask => t !== null);
      const planTextRaw = resolveStrictKey(nestedObj, "planText");
      const planText =
        typeof planTextRaw === "string" && planTextRaw.trim().length > 0
          ? planTextRaw.trim()
          : rawText;
      if (tasks.length === 0) {
        return {
          ok: false,
          plan: null,
          diagnostic: `Found JSON at root.${key}.tasks but no task had a recognizable 'title' field.`,
        };
      }
      return {
        ok: true,
        plan: { planText, tasks },
        diagnostic: `Found JSON at root.${key} — ${tasks.length} task(s) parsed successfully.`,
      };
    }
  }

  return {
    ok: false,
    plan: null,
    diagnostic:
      "Parsed JSON object but could not locate a tasks array at root or one level deep.",
  };
}

// ---------------------------------------------------------------------------
// LLM normalization fallback
// ---------------------------------------------------------------------------

async function normalizePlanWithLlm(rawText: string): Promise<PlanParseResult> {
  try {
    const result = await generateObject({
      model: openai("gpt-4.1-mini"),
      schema: planSpecSchema,
      prompt: `Extract the implementation plan from this agent output. Convert it to the canonical format.\n\n${rawText}`,
    });
    return {
      ok: true,
      plan: result.object as ParsedPlanSpec,
      diagnostic: "Plan normalized via LLM from non-canonical format.",
    };
  } catch {
    return {
      ok: false,
      plan: null,
      diagnostic:
        "Plan could not be parsed or normalized. Output a JSON with tasks[] array.",
    };
  }
}

// ---------------------------------------------------------------------------
// Markdown list fallback
// ---------------------------------------------------------------------------

const MARKDOWN_LIST_RE =
  /^(?:\d+[\.\)]|[-*]|(?:step|phase)\s+\d+[:.)-]?)\s+\S+/i;
const MARKDOWN_PREFIX_RE =
  /^(?:\d+[\.\)]|[-*]|(?:step|phase)\s+\d+[:.)-]?)\s+/i;

function parseMarkdownList(text: string): PlanParseResult {
  const tasks = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => MARKDOWN_LIST_RE.test(line))
    .map((line, index) => {
      const title = line.replace(MARKDOWN_PREFIX_RE, "");
      return {
        stableTaskId: `task-${index + 1}`,
        title,
        description: null,
        acceptance: [] as string[],
      };
    });

  if (tasks.length === 0) {
    return {
      ok: false,
      plan: null,
      diagnostic: "No JSON or structured list found in agent text.",
    };
  }

  return {
    ok: true,
    plan: { planText: text, tasks },
    diagnostic: `Parsed ${tasks.length} task(s) from markdown list fallback.`,
  };
}

// ---------------------------------------------------------------------------
// Strict canonical parser (sync, fast path)
// ---------------------------------------------------------------------------

function parseStrictCanonical(text: string): PlanParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      ok: false,
      plan: null,
      diagnostic: "Plan text is empty.",
    };
  }

  // Tier 1: direct JSON.parse
  try {
    const parsed = JSON.parse(trimmed);
    return parseJsonObject(parsed, trimmed);
  } catch {
    // not direct JSON — continue
  }

  // Tier 2: fenced ```json ``` blocks
  const fencedJsonMatches = [...trimmed.matchAll(/```json\s*([\s\S]*?)```/gi)];
  for (const match of fencedJsonMatches) {
    const candidate = match[1] ?? "";
    try {
      const parsed = JSON.parse(candidate);
      const result = parseJsonObject(parsed, trimmed);
      if (result.ok) return result;
    } catch {
      // continue to next fence
    }
  }

  return { ok: false, plan: null, diagnostic: "Strict parser found no match." };
}

// ---------------------------------------------------------------------------
// Main entry point (async — LLM fallback may be triggered)
// ---------------------------------------------------------------------------

export async function parsePlanSpec(text: string): Promise<PlanParseResult> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      ok: false,
      plan: null,
      diagnostic: "Plan text is empty.",
    };
  }

  // Phase 1: strict canonical parse (sync, fast)
  const strictResult = parseStrictCanonical(trimmed);
  if (strictResult.ok) return strictResult;

  // Phase 2: if input looks like JSON, try LLM normalization
  const hasJsonContent = /[{[\]]/.test(trimmed);
  if (hasJsonContent) {
    return normalizePlanWithLlm(trimmed);
  }

  // Phase 3: markdown list fallback (sync)
  return parseMarkdownList(trimmed);
}
