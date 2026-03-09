/**
 * Deterministic JSON plan parser with alias resolution.
 *
 * Resolves canonical keys first, then known agent aliases (Codex, Amp, etc).
 * Each alias maps to exactly one canonical field — no cross-field ambiguity.
 */

// ---------------------------------------------------------------------------
// Alias arrays — canonical key first, alternatives after.
// INVARIANT: no alias string appears in more than one array.
// ---------------------------------------------------------------------------

const TASKS_ARRAY_ALIASES = ["tasks", "steps", "plan_tasks", "items"] as const;

const TASK_TITLE_ALIASES = ["title", "name", "task_name", "label"] as const;

const TASK_ID_ALIASES = [
  "stableTaskId",
  "stable_task_id",
  "stableId",
  "stable_id",
  "taskId",
  "task_id",
  "id",
] as const;

const TASK_DESC_ALIASES = ["description", "details", "detail", "desc"] as const;

const TASK_ACCEPTANCE_ALIASES = [
  "acceptance",
  "acceptanceCriteria",
  "acceptance_criteria",
  "criteria",
] as const;

const PLAN_TEXT_ALIASES = [
  "planText",
  "plan_text",
  "summary",
  "overview",
] as const;

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

const PROPOSED_PLAN_TAG_RE =
  /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

// ---------------------------------------------------------------------------
// Key resolution — case-insensitive, deterministic priority
// ---------------------------------------------------------------------------

function resolveKey(
  obj: Record<string, unknown>,
  aliases: readonly string[],
): unknown | undefined {
  const lowerKeys = new Map<string, unknown>();
  for (const k of Object.keys(obj)) {
    lowerKeys.set(k.toLowerCase(), obj[k]);
  }
  for (const alias of aliases) {
    const val = lowerKeys.get(alias.toLowerCase());
    if (val !== undefined) return val;
  }
  return undefined;
}

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
// Single-task parser
// ---------------------------------------------------------------------------

function parseTask(raw: unknown, index: number): ParsedPlanTask | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  const titleRaw = resolveKey(obj, TASK_TITLE_ALIASES);
  if (typeof titleRaw !== "string" || titleRaw.trim().length === 0) return null;

  const title = titleRaw.trim();

  const idRaw = resolveKey(obj, TASK_ID_ALIASES);
  const stableTaskId =
    typeof idRaw === "string" && idRaw.trim().length > 0
      ? idRaw.trim()
      : normalizeStableTaskId(title, index);

  const descRaw = resolveKey(obj, TASK_DESC_ALIASES);
  const description =
    typeof descRaw === "string" && descRaw.trim().length > 0
      ? descRaw.trim()
      : null;

  const acceptanceRaw = resolveKey(obj, TASK_ACCEPTANCE_ALIASES);
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

  // Tier B: resolve tasks array at root level
  const tasksRaw = resolveKey(obj, TASKS_ARRAY_ALIASES);
  if (Array.isArray(tasksRaw)) {
    const tasks = tasksRaw
      .map((item, i) => parseTask(item, i))
      .filter((t): t is ParsedPlanTask => t !== null);
    const planTextRaw = resolveKey(obj, PLAN_TEXT_ALIASES);
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

  // Tier C: check one level of nesting
  for (const key of Object.keys(obj)) {
    const nested = obj[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested))
      continue;
    const nestedObj = nested as Record<string, unknown>;
    const nestedTasks = resolveKey(nestedObj, TASKS_ARRAY_ALIASES);
    if (Array.isArray(nestedTasks)) {
      const tasks = nestedTasks
        .map((item, i) => parseTask(item, i))
        .filter((t): t is ParsedPlanTask => t !== null);
      const planTextRaw = resolveKey(nestedObj, PLAN_TEXT_ALIASES);
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
      "Parsed JSON object but could not locate a tasks/steps array at root or one level deep.",
  };
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
// Truncated JSON repair — best-effort closing of brackets/braces
// ---------------------------------------------------------------------------

function tryRepairTruncatedJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;

  // Strip trailing comma and incomplete string literal
  let cleaned = trimmed.replace(/,\s*"[^"]*$/, "").replace(/,\s*$/, "");

  // Count unclosed brackets/braces
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (const ch of cleaned) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // If we're inside a string, close it
  if (inString) {
    cleaned += '"';
  }

  // Close remaining brackets/braces in reverse order
  while (stack.length > 0) {
    cleaned += stack.pop();
  }

  // Only return if we actually have something parseable
  try {
    JSON.parse(cleaned);
    return cleaned;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parsePlanSpec(text: string): PlanParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      ok: false,
      plan: null,
      diagnostic: "Plan text is empty.",
    };
  }

  const proposedPlanMatch = PROPOSED_PLAN_TAG_RE.exec(trimmed);
  if (proposedPlanMatch?.[1]) {
    const proposedBody = proposedPlanMatch[1].trim();
    if (proposedBody.length > 0 && proposedBody !== trimmed) {
      const nested = parsePlanSpec(proposedBody);
      if (nested.ok) {
        return {
          ok: true,
          plan: nested.plan,
          diagnostic: `Parsed plan from <proposed_plan> block. ${nested.diagnostic}`,
        };
      }
    }
  }

  // Tier 1: direct JSON.parse
  try {
    const parsed = JSON.parse(trimmed);
    return parseJsonObject(parsed, trimmed);
  } catch {
    // not direct JSON — continue
  }

  // Tier 2: fenced ```json ``` blocks (closed)
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

  // Tier 2b: unclosed fenced JSON (truncated agent output)
  const unclosedFenceMatch = trimmed.match(/```json\s*([\s\S]+)$/i);
  if (unclosedFenceMatch) {
    const candidate = unclosedFenceMatch[1] ?? "";
    const repaired = tryRepairTruncatedJson(candidate);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired);
        const result = parseJsonObject(parsed, trimmed);
        if (result.ok) return result;
      } catch {
        // repair wasn't sufficient
      }
    }
  }

  // Tier 2c: bare JSON object (no fences)
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace >= 0) {
    const bareCandidate = trimmed.slice(firstBrace);
    // Try direct parse first
    try {
      const parsed = JSON.parse(bareCandidate);
      const result = parseJsonObject(parsed, trimmed);
      if (result.ok) return result;
    } catch {
      // Try repair on bare JSON
      const repaired = tryRepairTruncatedJson(bareCandidate);
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired);
          const result = parseJsonObject(parsed, trimmed);
          if (result.ok) return result;
        } catch {
          // repair wasn't sufficient
        }
      }
    }
  }

  // Tier 3: markdown list fallback
  return parseMarkdownList(trimmed);
}
