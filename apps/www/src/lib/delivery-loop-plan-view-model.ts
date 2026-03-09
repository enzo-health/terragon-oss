import {
  normalizeStableTaskId,
  parsePlanSpec,
  type ParsedPlanTask,
} from "@/server-lib/sdlc-loop/parse-plan-spec";

export type PlanRenderSource =
  | "proposed_plan_tag"
  | "json_plan_spec"
  | "artifact_fallback";

export type PlanTaskViewModel = {
  stableTaskId: string;
  title: string;
  description: string | null;
  acceptance: string[];
};

export type PlanSpecViewModel = {
  title: string;
  summary: string;
  tasks: PlanTaskViewModel[];
  assumptions: string[];
  source: PlanRenderSource;
};

const PROPOSED_PLAN_TAG_RE =
  /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;

function parseHeadingTitle(markdown: string): string {
  const headingMatch = markdown.match(/^#{1,6}\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }
  return "Implementation Plan";
}

function splitMarkdownSections(
  markdown: string,
): Array<{ heading: string; body: string }> {
  const lines = markdown.split("\n");
  const sections: Array<{ heading: string; body: string }> = [];

  let currentHeading = "";
  let currentBody: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch?.[1]) {
      sections.push({
        heading: currentHeading.trim().toLowerCase(),
        body: currentBody.join("\n").trim(),
      });
      currentHeading = headingMatch[1];
      currentBody = [];
      continue;
    }
    currentBody.push(rawLine);
  }

  sections.push({
    heading: currentHeading.trim().toLowerCase(),
    body: currentBody.join("\n").trim(),
  });

  return sections;
}

function parseSectionBullets(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

function parseTasksFromNumberedList(markdown: string): PlanTaskViewModel[] {
  const lines = markdown.split("\n");
  const tasks: PlanTaskViewModel[] = [];
  let currentTask: PlanTaskViewModel | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/);
    if (numberedMatch?.[2]) {
      if (currentTask) {
        tasks.push(currentTask);
      }
      const title = numberedMatch[2]
        .replace(/\*\*/g, "")
        .replace(/:$/, "")
        .trim();
      const stableTaskId = normalizeStableTaskId(title, tasks.length);
      currentTask = {
        stableTaskId,
        title,
        description: null,
        acceptance: [],
      };
      continue;
    }

    if (!currentTask) {
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch?.[1]) {
      const bullet = bulletMatch[1].trim();
      if (bullet.toLowerCase().startsWith("acceptance:")) {
        const acceptance = bullet.replace(/^acceptance:\s*/i, "").trim();
        if (acceptance.length > 0) {
          currentTask.acceptance.push(acceptance);
        }
        continue;
      }

      if (currentTask.description) {
        currentTask.description = `${currentTask.description} ${bullet}`.trim();
      } else {
        currentTask.description = bullet;
      }
    }
  }

  if (currentTask) {
    tasks.push(currentTask);
  }

  return tasks;
}

function mapParsedTasks(tasks: ParsedPlanTask[]): PlanTaskViewModel[] {
  return tasks.map((task) => ({
    stableTaskId: task.stableTaskId,
    title: task.title,
    description: task.description,
    acceptance: task.acceptance,
  }));
}

function parseProposedPlan(markdown: string): PlanSpecViewModel | null {
  const normalized = markdown.trim();
  if (normalized.length === 0) {
    return null;
  }

  const sections = splitMarkdownSections(normalized);
  const summarySection = sections.find(
    (section) => section.heading === "summary",
  );
  const assumptionSection = sections.find(
    (section) =>
      section.heading === "assumptions / defaults" ||
      section.heading === "assumptions" ||
      section.heading === "defaults",
  );

  const parsed = parsePlanSpec(normalized);
  const parsedTasks = parsed.ok ? mapParsedTasks(parsed.plan.tasks) : [];
  const numberedTasks = parseTasksFromNumberedList(normalized);
  const tasks = numberedTasks.length > 0 ? numberedTasks : parsedTasks;

  if (tasks.length === 0) {
    return null;
  }

  return {
    title: parseHeadingTitle(normalized),
    summary: summarySection?.body || normalized,
    tasks,
    assumptions: assumptionSection
      ? parseSectionBullets(assumptionSection.body)
      : [],
    source: "proposed_plan_tag",
  };
}

export function extractProposedPlanBlock(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const match = PROPOSED_PLAN_TAG_RE.exec(trimmed);
  return match?.[1]?.trim() ?? null;
}

export function parsePlanSpecViewModelFromText(
  text: string,
): PlanSpecViewModel | null {
  const proposedPlanBlock = extractProposedPlanBlock(text);
  if (proposedPlanBlock) {
    const fromProposed = parseProposedPlan(proposedPlanBlock);
    if (fromProposed) {
      return fromProposed;
    }
  }

  const parsed = parsePlanSpec(text);
  if (!parsed.ok) {
    return null;
  }

  return {
    title: "Implementation Plan",
    summary: parsed.plan.planText,
    tasks: mapParsedTasks(parsed.plan.tasks),
    assumptions: [],
    source: "json_plan_spec",
  };
}

export function buildArtifactFallbackPlanSpecViewModel({
  summary,
  tasks,
}: {
  summary: string;
  tasks: PlanTaskViewModel[];
}): PlanSpecViewModel | null {
  if (tasks.length === 0) {
    return null;
  }

  return {
    title: "Implementation Plan",
    summary,
    tasks,
    assumptions: [],
    source: "artifact_fallback",
  };
}
