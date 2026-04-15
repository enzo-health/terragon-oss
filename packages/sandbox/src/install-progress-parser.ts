/**
 * Parses pnpm stdout lines to extract dependency-installation progress.
 *
 * pnpm produces three kinds of lines we care about:
 *
 *   Progress: resolved 392, reused 147, downloaded 18, added 12, done
 *   Scope: all 47 workspace projects
 *   .   node_modules/.pnpm/@scope+pkg@1.2.3/node_modules/@scope/pkg/...
 *
 * The parser is intentionally defensive: it strips ANSI escape codes first,
 * never throws on any input (including binary/unicode blobs), and returns null
 * for lines it doesn't recognise.
 */

export type InstallProgressSnapshot = {
  resolved: number;
  reused: number;
  downloaded: number;
  added: number;
  total?: number;
  currentPackage?: string;
};

// Matches ANSI CSI escape sequences so they can be stripped before parsing.
// Using a character-class range instead of the Unicode flag keeps it
// compatible with all Node.js targets in this repo.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Strip ANSI escape sequences from a string.  Returns the original string
 * unchanged if it contains no escape sequences (fast-path with no allocation).
 */
function stripAnsi(line: string): string {
  if (!line.includes("\x1b")) {
    return line;
  }
  return line.replace(ANSI_ESCAPE_RE, "");
}

// Progress: resolved 392, reused 147, downloaded 18, added 12[, done]
const PROGRESS_RE =
  /^Progress:\s+resolved\s+(\d+),\s+reused\s+(\d+),\s+downloaded\s+(\d+),\s+added\s+(\d+)/;

// Scope: all 47 workspace projects
const SCOPE_RE = /^Scope:\s+all\s+(\d+)\s+workspace\s+project/;

// Per-package install line — starts with optional whitespace / dot, then the
// node_modules/.pnpm/<package>@<version> path prefix.  We extract just the
// package name (without version) for display.
//
// pnpm encodes scoped package names in the filesystem path using `+` instead
// of `/`, so `@scope/pkg` becomes `@scope+pkg` in the directory name.
//
// Handles scoped packages:  node_modules/.pnpm/@scope+pkg@1.2.3/...
//                and plain:  node_modules/.pnpm/react@19.1.0/...
const PACKAGE_LINE_RE =
  /^\s*\.?\s*node_modules\/\.pnpm\/(@[\w.-]+\+[\w.-]+|[\w.-]+)@/;

/**
 * Parse a single line of pnpm stdout.
 *
 * Returns a `Partial<InstallProgressSnapshot>` containing only the fields
 * present in this line, or `null` if the line carries no recognised progress
 * information.
 */
export function parsePnpmProgressLine(
  line: string,
): Partial<InstallProgressSnapshot> | null {
  // Guard against non-string input without using `any`.
  if (typeof line !== "string") {
    return null;
  }

  // Strip ANSI codes and trim trailing whitespace/newlines.
  const clean = stripAnsi(line).trimEnd();

  // 1. Progress line
  const progressMatch = PROGRESS_RE.exec(clean);
  if (progressMatch) {
    const g1 = progressMatch[1] ?? "";
    const g2 = progressMatch[2] ?? "";
    const g3 = progressMatch[3] ?? "";
    const g4 = progressMatch[4] ?? "";
    const resolved = parseInt(g1, 10);
    const reused = parseInt(g2, 10);
    const downloaded = parseInt(g3, 10);
    const added = parseInt(g4, 10);
    if (
      !Number.isNaN(resolved) &&
      !Number.isNaN(reused) &&
      !Number.isNaN(downloaded) &&
      !Number.isNaN(added)
    ) {
      return { resolved, reused, downloaded, added };
    }
    return null;
  }

  // 2. Scope line
  const scopeMatch = SCOPE_RE.exec(clean);
  if (scopeMatch) {
    const total = parseInt(scopeMatch[1] ?? "", 10);
    if (!Number.isNaN(total)) {
      return { total };
    }
    return null;
  }

  // 3. Per-package line
  const packageMatch = PACKAGE_LINE_RE.exec(clean);
  if (packageMatch) {
    // packageMatch[1] is the full package name (scoped or plain), without
    // the @version suffix.
    const rawName = packageMatch[1] ?? "";
    if (!rawName) return null;
    // Replace the pnpm encoding of scoped packages (+) back to /
    const currentPackage = rawName.replace(/\+/g, "/");
    return { currentPackage };
  }

  return null;
}
