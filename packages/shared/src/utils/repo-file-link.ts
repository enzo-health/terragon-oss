/**
 * Pure path/URL helpers for the in-repo file preview feature.
 *
 * These have no DB or sandbox coupling — they only decide whether an href
 * points at a file inside the current repo workspace and, if so, normalize it.
 * The orchestration that loads content lives in apps/www.
 */

/** A normalized, repo-relative line range parsed from a `#Lstart-Lend` anchor. */
export interface RepoFileLineRange {
  start: number;
  end: number;
}

export interface ClassifiedRepoFileLink {
  /**
   * Repo-relative path with no leading slash, no `./`, and no `..` segments.
   * Workspace-root-absolute inputs (`/src/foo.ts`) are normalized to the
   * relative form (`src/foo.ts`).
   */
  path: string;
  /** Optional line range parsed from a trailing `#Lstart` or `#Lstart-Lend` anchor. */
  lineRange?: RepoFileLineRange;
}

/**
 * URI schemes treated as external links rather than in-repo file paths. This
 * inverts the allowlist in `resource-link-view.tsx`: any href that parses as an
 * absolute URL (http/https/mailto/javascript/data/file/...) is NOT an in-repo
 * file. Only scheme-less relative or workspace-root-absolute paths qualify.
 */
function hasUriScheme(href: string): boolean {
  // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
  // Match leading scheme; protocol-relative `//host` is also external.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return true;
  if (href.startsWith("//")) return true;
  return false;
}

/**
 * Absolute path the repo is cloned to inside every sandbox. Agents routinely
 * emit absolute paths (`/root/repo/apps/foo.ts`) in markdown links and tool
 * output, so we map that sandbox-absolute form back to the repo-relative path
 * GitHub `getContent` expects. Mirrors the clone target in
 * `packages/sandbox/src/snapshot-builder.ts` (homeDir `root` + repoDir `repo`);
 * inlined as a literal to keep this util free of sandbox coupling.
 */
const SANDBOX_REPO_ROOT = "/root/repo";

/**
 * Map a sandbox-absolute path under the repo clone root to its repo-relative
 * form. `/root/repo/apps/foo.ts` → `/apps/foo.ts`; `/root/repo` (the bare root)
 * → ``. Any other input passes through unchanged so the generic
 * leading-slash/`.` normalization below still applies.
 */
function stripSandboxRepoRoot(rawPath: string): string {
  if (rawPath === SANDBOX_REPO_ROOT) return "";
  if (rawPath.startsWith(`${SANDBOX_REPO_ROOT}/`)) {
    return rawPath.slice(SANDBOX_REPO_ROOT.length);
  }
  return rawPath;
}

function parseLineAnchor(anchor: string): RepoFileLineRange | undefined {
  // Accept `L12` or `L12-L34` (also tolerates `L12-34`), case-insensitive.
  const match = /^L(\d+)(?:-L?(\d+))?$/i.exec(anchor);
  if (!match?.[1]) return undefined;
  const start = Number.parseInt(match[1], 10);
  if (!Number.isFinite(start) || start <= 0) return undefined;
  const end = match[2] ? Number.parseInt(match[2], 10) : start;
  if (!Number.isFinite(end) || end < start) return undefined;
  return { start, end };
}

/**
 * Normalize a repo path, rejecting any `..` traversal. Returns null if the path
 * would escape the workspace root or is empty after normalization.
 *
 * Only literal `..` segments are rejected. A percent-encoded sequence like
 * `%2e%2e%2f` is NOT decoded and survives as a single opaque path segment. This
 * does not let a caller escape the repo: the literal segment is handed to
 * octokit `repos.getContent`, which is repo-scoped and 404s for a non-existent
 * path, so it can never read outside the repo tree. We deliberately do not
 * decode here — decoding would reintroduce ambiguity about what the canonical
 * path is, and the repo-scoped fetch is the real boundary.
 */
function normalizeRepoPath(rawPath: string): string | null {
  if (rawPath.length === 0) return null;

  // Map a sandbox-absolute path (`/root/repo/...`) to repo-relative first, then
  // strip a single leading slash (workspace-root-absolute → relative) and a
  // leading `./`.
  let path = stripSandboxRepoRoot(rawPath)
    .replace(/^\/+/, "")
    .replace(/^\.\//, "");

  const segments = path.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null; // reject traversal, never pop
    normalized.push(segment);
  }

  if (normalized.length === 0) return null;
  return normalized.join("/");
}

/**
 * Classify an href as an in-repo file link. Returns a normalized result when
 * the href is a scheme-less repo-relative or workspace-root-absolute path
 * (optionally with a `#Lstart-Lend` line anchor), or null for external URLs,
 * dangerous schemes (`javascript:`, `data:`, etc.), traversal attempts, or
 * empty/non-file inputs.
 */
export function classifyRepoFileLink(
  href: string,
): ClassifiedRepoFileLink | null {
  if (typeof href !== "string") return null;

  const trimmed = href.trim();
  if (trimmed.length === 0) return null;

  // Any scheme (including dangerous ones) or protocol-relative → external.
  if (hasUriScheme(trimmed)) return null;

  // A bare anchor (`#L1`) targets the current document, not a repo file.
  if (trimmed.startsWith("#")) return null;

  const hashIndex = trimmed.indexOf("#");
  const pathPart = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const anchorPart = hashIndex === -1 ? "" : trimmed.slice(hashIndex + 1);

  // Query strings have no meaning for a repo file path; reject to stay strict.
  if (pathPart.includes("?")) return null;

  const path = normalizeRepoPath(pathPart);
  if (path === null) return null;

  const lineRange = anchorPart ? parseLineAnchor(anchorPart) : undefined;
  // A non-empty anchor that does not parse as a line range is suspicious; keep
  // the path but drop the unparseable anchor rather than failing the link.
  return lineRange ? { path, lineRange } : { path };
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);

/** Case-insensitive `.md`/`.mdx` detector. */
export function isMarkdownFile(path: string): boolean {
  if (typeof path !== "string") return false;
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return false;
  return MARKDOWN_EXTENSIONS.has(path.slice(lastDot).toLowerCase());
}
