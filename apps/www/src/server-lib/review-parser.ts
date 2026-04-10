/**
 * Parses structured AI review output into typed data structures.
 *
 * The AI outputs a specific format with section headers (### SUMMARY, etc.)
 * and JSON code blocks for individual comments and resolutions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewCommentPriority = "high" | "medium" | "low";

export type ReviewRiskLevel = "low" | "medium" | "high";

export type ReviewResolution =
  | "resolved"
  | "partially_resolved"
  | "not_addressed";

export interface ParsedReviewComment {
  file: string;
  line: number | null;
  priority: ReviewCommentPriority;
  body: string;
  introducedByPr: boolean;
}

export interface ParsedReviewOutput {
  summary: string;
  codeChangeSummary: string;
  doneWell: string;
  riskLevel: ReviewRiskLevel;
  comments: ParsedReviewComment[];
}

export interface ParsedResolution {
  commentIndex: number;
  resolution: ReviewResolution;
  note: string;
}

export interface ParsedReReviewOutput {
  resolutions: ParsedResolution[];
  newComments: ParsedReviewComment[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text between a section header and the next section header (or end of string).
 * Section headers are lines starting with `### `.
 */
function extractSection(output: string, sectionName: string): string {
  // Match the section header (case-insensitive) and capture everything until the next ### or end
  const pattern = new RegExp(
    `###\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=###\\s|$)`,
    "i",
  );
  const match = output.match(pattern);
  return match?.[1]?.trim() ?? "";
}

/**
 * Extract all JSON code blocks from a string.
 * Matches ```json ... ``` blocks as well as bare { ... } blocks on their own lines.
 */
function extractJsonBlocks(text: string): unknown[] {
  const results: unknown[] = [];

  // Match fenced JSON code blocks
  const fencedPattern = /```json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencedPattern.exec(text)) !== null) {
    const jsonStr = match[1]?.trim();
    if (jsonStr) {
      try {
        results.push(JSON.parse(jsonStr));
      } catch {
        // Skip malformed JSON blocks
      }
    }
  }

  return results;
}

function normalizePriority(value: string): ReviewCommentPriority {
  const lower = value.toLowerCase().trim();
  if (lower === "high" || lower === "medium" || lower === "low") {
    return lower;
  }
  // Default to medium for unrecognized values
  return "medium";
}

function normalizeRiskLevel(value: string): ReviewRiskLevel {
  const lower = value.toLowerCase().trim();
  if (lower === "high" || lower === "medium" || lower === "low") {
    return lower;
  }
  return "medium";
}

function normalizeResolution(value: string): ReviewResolution {
  const lower = value.toLowerCase().trim();
  if (
    lower === "resolved" ||
    lower === "partially_resolved" ||
    lower === "not_addressed"
  ) {
    return lower;
  }
  return "not_addressed";
}

function parseComment(raw: unknown): ParsedReviewComment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const file = typeof obj.file === "string" ? obj.file : null;
  if (!file) return null;

  return {
    file,
    line: typeof obj.line === "number" ? obj.line : null,
    priority: normalizePriority(
      typeof obj.priority === "string" ? obj.priority : "medium",
    ),
    body: typeof obj.body === "string" ? obj.body : "",
    introducedByPr:
      typeof obj.introducedByPr === "boolean" ? obj.introducedByPr : true,
  };
}

function parseResolution(raw: unknown): ParsedResolution | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const commentIndex =
    typeof obj.commentIndex === "number" ? obj.commentIndex : null;
  if (commentIndex === null) return null;

  return {
    commentIndex,
    resolution: normalizeResolution(
      typeof obj.resolution === "string" ? obj.resolution : "not_addressed",
    ),
    note: typeof obj.note === "string" ? obj.note : "",
  };
}

// ---------------------------------------------------------------------------
// Main parsers
// ---------------------------------------------------------------------------

export function parseReviewOutput(output: string): ParsedReviewOutput {
  const summary = extractSection(output, "SUMMARY");
  const codeChangeSummary = extractSection(output, "CODE_CHANGE_SUMMARY");
  const doneWell = extractSection(output, "DONE_WELL");

  // Parse RISK_LEVEL — should be a single word on a line
  const riskLevelRaw = extractSection(output, "RISK_LEVEL");
  const riskLevel = normalizeRiskLevel(riskLevelRaw);

  // Parse COMMENTS section — extract all JSON blocks after the COMMENTS header
  const commentsSection = extractSection(output, "COMMENTS");
  const commentBlocks = extractJsonBlocks(commentsSection);
  const comments: ParsedReviewComment[] = [];
  for (const block of commentBlocks) {
    const parsed = parseComment(block);
    if (parsed) {
      comments.push(parsed);
    }
  }

  return {
    summary,
    codeChangeSummary,
    doneWell,
    riskLevel,
    comments,
  };
}

export function parseReReviewOutput(output: string): ParsedReReviewOutput {
  // Resolutions are JSON blocks that appear before the NEW_COMMENTS section
  // We split the output at NEW_COMMENTS to separate them
  const newCommentsIdx = output.search(/###\s+NEW_COMMENTS/i);
  const resolutionsPart =
    newCommentsIdx >= 0 ? output.slice(0, newCommentsIdx) : output;
  const newCommentsPart =
    newCommentsIdx >= 0 ? output.slice(newCommentsIdx) : "";

  // Parse resolution blocks
  const resolutionBlocks = extractJsonBlocks(resolutionsPart);
  const resolutions: ParsedResolution[] = [];
  for (const block of resolutionBlocks) {
    const parsed = parseResolution(block);
    if (parsed) {
      resolutions.push(parsed);
    }
  }

  // Parse new comment blocks
  const newCommentBlocks = extractJsonBlocks(newCommentsPart);
  const newComments: ParsedReviewComment[] = [];
  for (const block of newCommentBlocks) {
    const parsed = parseComment(block);
    if (parsed) {
      newComments.push(parsed);
    }
  }

  return {
    resolutions,
    newComments,
  };
}
