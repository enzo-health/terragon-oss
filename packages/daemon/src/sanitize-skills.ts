import fs from "node:fs";
import path from "node:path";

type Logger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * Extracts YAML frontmatter from a markdown file's content.
 * Returns null if no frontmatter block is found.
 */
export function extractFrontmatter(content: string): string | null {
  // Support both LF and CRLF line endings, and require exactly "---"
  // followed by a newline (not "----" or other variants).
  let startIndex: number;
  let newline: "\n" | "\r\n";

  if (content.startsWith("---\r\n")) {
    startIndex = "---\r\n".length;
    newline = "\r\n";
  } else if (content.startsWith("---\n")) {
    startIndex = "---\n".length;
    newline = "\n";
  } else {
    return null;
  }

  const closingWithTrailing = `${newline}---${newline}`;
  let endIndex = content.indexOf(closingWithTrailing, startIndex);
  if (endIndex === -1) {
    const closingAtEnd = `${newline}---`;
    if (content.endsWith(closingAtEnd)) {
      endIndex = content.length - closingAtEnd.length;
    } else {
      return null;
    }
  }
  return content.substring(startIndex, endIndex);
}

/**
 * Checks if YAML frontmatter is structurally valid enough for Codex to parse.
 *
 * Codex uses a strict YAML parser that rejects values with unquoted colons,
 * unclosed quotes, and other syntax errors. This performs a lightweight
 * structural check without requiring a YAML library:
 *
 * 1. Every non-empty, non-comment line must have a colon separator
 * 2. Values containing colons must be quoted
 * 3. Quotes must be balanced
 */
export function isFrontmatterValid(frontmatter: string): boolean {
  const lines = frontmatter.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Indented lines are block scalar continuation or nested content — skip
    if (line.startsWith(" ") || line.startsWith("\t")) {
      continue;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      // No colon at all — invalid YAML key-value line (unless it's a list
      // item like "- value", which is valid)
      if (trimmed.startsWith("-")) {
        continue;
      }
      return false;
    }

    const value = trimmed.substring(colonIndex + 1).trim();
    if (!value) {
      // Empty value or block scalar start — that's fine
      continue;
    }

    // Check for unquoted values that contain "colon-space" — the YAML mapping
    // value indicator that Codex's strict parser rejects. Bare colons without
    // a trailing space (e.g. URLs like https://... or timestamps) are valid
    // in YAML plain scalars and must not be flagged.
    if (
      !value.startsWith('"') &&
      !value.startsWith("'") &&
      !value.startsWith("[") &&
      !value.startsWith("{") &&
      !value.startsWith("|") &&
      !value.startsWith(">") &&
      value.includes(": ")
    ) {
      return false;
    }

    // Check for unbalanced quotes
    if (value.startsWith('"') && !value.endsWith('"')) {
      return false;
    }
    if (value.startsWith("'") && !value.endsWith("'")) {
      return false;
    }
  }
  return true;
}

/**
 * Scans the repo's `.claude/skills/` directory for markdown files with invalid
 * YAML frontmatter and renames them so Codex won't attempt to load them.
 *
 * This is a pre-flight check — Codex treats invalid skill YAML as a fatal
 * error and crashes the entire app-server process.
 */
export function sanitizeRepoSkillFiles(logger: Logger): void {
  const skillsDir = path.join(process.cwd(), ".claude", "skills");

  if (!fs.existsSync(skillsDir)) {
    return;
  }

  const walkDir = (dir: string): string[] => {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walkDir(fullPath));
        } else if (entry.name.endsWith(".md")) {
          results.push(fullPath);
        }
      }
    } catch {
      // Permission errors or broken symlinks — skip silently
    }
    return results;
  };

  const files = walkDir(skillsDir);
  if (files.length === 0) {
    return;
  }

  let invalidCount = 0;
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const frontmatter = extractFrontmatter(content);
      if (frontmatter === null) {
        // No frontmatter — Codex might still try to parse it. Skip; if it
        // has no --- block at all, Codex handles it gracefully.
        continue;
      }
      if (!isFrontmatterValid(frontmatter)) {
        const disabledPath = `${filePath}.disabled`;
        fs.renameSync(filePath, disabledPath);
        invalidCount++;
        logger.warn("Disabled skill file with invalid YAML frontmatter", {
          original: filePath,
          renamed: disabledPath,
        });
      }
    } catch (error) {
      logger.warn("Failed to validate skill file", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (invalidCount > 0) {
    logger.info(
      `Sanitized ${invalidCount} skill file(s) with invalid YAML frontmatter`,
      { directory: skillsDir, invalidCount },
    );
  }
}
