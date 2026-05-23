import { ExternalLink } from "lucide-react";
import {
  type ComponentProps,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MarkdownRenderer } from "@/components/ai-elements/markdown-renderer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ImagePart } from "./image-part";

interface TextPartProps {
  text: string;
  streaming?: boolean;
  githubRepoFullName?: string;
  branchName?: string;
  baseBranchName?: string;
  hasCheckpoint?: boolean;
  onOpenInArtifactWorkspace?: () => void;
}

function convertCitationsToGitHubLinks(
  text: string,
  githubRepoFullName?: string,
  branchName?: string,
  baseBranchName?: string,
  hasCheckpoint?: boolean,
): string {
  if (!githubRepoFullName) return text;
  if (!text.includes("【F:")) return text;

  // Pattern to match citations like 【F:filename†L1-L6】or 【F:filename†L1】
  const citationPattern = /【F:([^†]+)†L(\d+)(?:-L?(\d+))?】/g;

  return text.replace(
    citationPattern,
    (match, filename, startLine, endLine) => {
      // Use the current branch only if a checkpoint has been made and pushed
      const targetBranch =
        hasCheckpoint && branchName ? branchName : baseBranchName || "main";
      const baseUrl = `https://github.com/${githubRepoFullName}/blob/${targetBranch}/${filename}`;
      if (endLine) {
        return `[${filename}:L${startLine}-L${endLine}](${baseUrl}#L${startLine}-L${endLine})`;
      } else {
        return `[${filename}:L${startLine}](${baseUrl}#L${startLine})`;
      }
    },
  );
}

/**
 * Insert paragraph breaks after bold text at the start of a line that runs
 * directly into body text (no whitespace separator). ACP transports like Codex
 * emit a bold "thinking header" (e.g. **Preparing reply**) followed immediately
 * by the response body with no newline, which renders as one cramped paragraph.
 */
function normalizeBoldHeaders(text: string): string {
  if (!text.includes("**")) return text;
  return text.replace(/^(\*\*[^*]+\*\*)([A-Za-z])/gm, "$1\n\n$2");
}

const PROPOSED_PLAN_RE = /<proposed_plan>[\s\S]*?<\/proposed_plan>/g;
const POSSIBLE_CODE_BLOCK_RE = /```|~~~|(?:^|\n)(?: {4}|\t)\S/;
const MARKDOWN_SYNTAX_RE =
  /```|~~~|`|\*\*|__|~~|!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\)|(?:^|\n)\s*(?:[-*+]|\d+\.)\s|(?:^|\n)\s{0,3}(?:#{1,6}\s|>|\|)|<[^>\n]+>/;
const STREAMING_MARKDOWN_SYNTAX_RE =
  /```|~~~|\*\*|__|~~|!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\)|(?:^|\n)\s{0,3}(?:#{1,6}\s|>|\|)|<[^>\n]+>/;
const MARKDOWN_CONTROLS = { code: true } satisfies NonNullable<
  ComponentProps<typeof MarkdownRenderer>["controls"]
>;

const COLLAPSE_THRESHOLD = 20;
const VISIBLE_LINES = 15;
const LINE_HEIGHT_PX = 22;
const PROPOSED_PLAN_START = "<proposed_plan";

interface BlockInfo {
  totalLines: number;
  expanded: boolean;
}

export function shouldScanCodeBlocks({
  hasPossibleCodeBlock,
  streaming,
}: {
  hasPossibleCodeBlock: boolean;
  streaming: boolean;
}): boolean {
  return hasPossibleCodeBlock && !streaming;
}

function CollapsibleCodeBlockOverlay({
  totalLines,
  isExpanded,
  onToggle,
}: {
  totalLines: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const hiddenLines = totalLines - VISIBLE_LINES;
  if (hiddenLines <= 0) return null;

  return (
    <div
      className={cn(
        "absolute right-0 bottom-0 left-0 z-10 flex items-end justify-center transition-opacity",
        !isExpanded && "pointer-events-none",
      )}
      style={!isExpanded ? { height: `${LINE_HEIGHT_PX * 4}px` } : undefined}
    >
      {!isExpanded && (
        <div className="absolute inset-0 bg-gradient-to-t from-sidebar to-transparent" />
      )}
      <button
        type="button"
        onClick={onToggle}
        className="pointer-events-auto relative z-20 mb-1 cursor-pointer rounded-md border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm transition-[background-color,color,scale] duration-150 hover:bg-muted hover:text-foreground active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {isExpanded ? "Show less" : `Show ${hiddenLines} more lines`}
      </button>
    </div>
  );
}

function scanForCodeBlocks(
  container: HTMLElement,
): Map<number, { totalLines: number }> {
  const result = new Map<number, { totalLines: number }>();
  const bodies = container.querySelectorAll<HTMLElement>(
    '[data-streamdown="code-block-body"]',
  );
  bodies.forEach((body, index) => {
    const codeEl = body.querySelector("code");
    if (!codeEl) return;
    const lineCount = codeEl.children.length;
    if (lineCount > COLLAPSE_THRESHOLD) {
      result.set(index, { totalLines: lineCount });
    }
  });
  return result;
}

const TextPart = memo(function TextPart({
  text,
  streaming = false,
  githubRepoFullName,
  branchName,
  baseBranchName,
  hasCheckpoint,
  onOpenInArtifactWorkspace,
}: TextPartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [blocks, setBlocks] = useState<Map<number, BlockInfo>>(new Map());
  // Track scan results separately from expand state to avoid re-scan loops
  const lastScanRef = useRef<string>("");
  const hasCompleteProposedPlan = useMemo(() => {
    PROPOSED_PLAN_RE.lastIndex = 0;
    return PROPOSED_PLAN_RE.test(text);
  }, [text]);
  const hasPossibleCodeBlock = useMemo(
    () => POSSIBLE_CODE_BLOCK_RE.test(text),
    [text],
  );
  const canScanCodeBlocks = shouldScanCodeBlocks({
    hasPossibleCodeBlock,
    streaming,
  });

  const processedText = useMemo(() => {
    let t = normalizeBoldHeaders(
      convertCitationsToGitHubLinks(
        text,
        githubRepoFullName,
        branchName,
        baseBranchName,
        hasCheckpoint,
      ),
    );
    if (hasCompleteProposedPlan && onOpenInArtifactWorkspace) {
      PROPOSED_PLAN_RE.lastIndex = 0;
      t = t.replace(PROPOSED_PLAN_RE, "").trim();
    }
    return t;
  }, [
    text,
    githubRepoFullName,
    branchName,
    baseBranchName,
    hasCheckpoint,
    hasCompleteProposedPlan,
    onOpenInArtifactWorkspace,
  ]);

  // Scan for collapsible code blocks after DOM updates.
  // Streaming inserts a text node per character — without coalescing, this
  // observer fires hundreds of times per second. We debounce to 150ms which
  // is well below human-perceptible latency for "show more" affordances.
  useEffect(() => {
    if (!canScanCodeBlocks) {
      lastScanRef.current = "";
      setBlocks((prev) => (prev.size > 0 ? new Map() : prev));
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const runScan = () => {
      const scanned = scanForCodeBlocks(container);
      // Build a fingerprint of the scan results to avoid unnecessary state updates
      const fingerprint = Array.from(scanned.entries())
        .map(([i, v]) => `${i}:${v.totalLines}`)
        .join(",");
      if (fingerprint === lastScanRef.current) return;
      lastScanRef.current = fingerprint;

      setBlocks((prev) => {
        const next = new Map<number, BlockInfo>();
        for (const [index, info] of scanned) {
          const existing = prev.get(index);
          next.set(index, {
            totalLines: info.totalLines,
            expanded: existing?.expanded ?? false,
          });
        }
        return next;
      });
    };

    runScan();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedScan = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        runScan();
      }, 150);
    };
    const observer = new MutationObserver(debouncedScan);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [canScanCodeBlocks]);

  // Apply collapse styles imperatively to code-block-body elements
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const bodies = container.querySelectorAll<HTMLElement>(
      '[data-streamdown="code-block-body"]',
    );
    bodies.forEach((body, index) => {
      const entry = blocks.get(index);
      if (entry) {
        body.style.transition =
          "max-height var(--duration-base) var(--ease-standard)";
        body.style.position = "relative";
        if (!entry.expanded) {
          body.style.maxHeight = `${VISIBLE_LINES * LINE_HEIGHT_PX}px`;
          body.style.overflow = "hidden";
        } else {
          // Use scrollHeight for a concrete target so CSS can interpolate
          body.style.maxHeight = `${body.scrollHeight}px`;
          body.style.overflow = "";
          // After transition completes, remove maxHeight so the element
          // can grow naturally if content changes
          const onEnd = () => {
            body.style.maxHeight = "";
            body.removeEventListener("transitionend", onEnd);
          };
          body.addEventListener("transitionend", onEnd, { once: true });
        }
      } else {
        body.style.maxHeight = "";
        body.style.overflow = "";
        body.style.transition = "";
      }
    });
  }, [blocks]);

  const toggleBlock = useCallback((index: number) => {
    setBlocks((prev) => {
      const next = new Map(prev);
      const entry = next.get(index);
      if (entry) {
        next.set(index, { ...entry, expanded: !entry.expanded });
      }
      return next;
    });
  }, []);

  // Render portals into code-block-body elements for collapse overlays
  const overlays = useMemo(() => {
    const container = containerRef.current;
    if (!container || blocks.size === 0) return null;

    const bodies = container.querySelectorAll<HTMLElement>(
      '[data-streamdown="code-block-body"]',
    );

    const portals: ReactNode[] = [];
    bodies.forEach((body, index) => {
      const entry = blocks.get(index);
      if (!entry) return;
      portals.push(
        createPortal(
          <CollapsibleCodeBlockOverlay
            key={index}
            totalLines={entry.totalLines}
            isExpanded={entry.expanded}
            onToggle={() => toggleBlock(index)}
          />,
          body,
        ),
      );
    });
    return portals.length > 0 ? portals : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, toggleBlock]);

  const showStreamdown = processedText.length > 0;
  const hasMarkdownSyntax = useMemo(
    () =>
      (streaming ? STREAMING_MARKDOWN_SYNTAX_RE : MARKDOWN_SYNTAX_RE).test(
        processedText,
      ),
    [processedText, streaming],
  );
  const renderImage = useCallback(
    (src: string, alt?: string) => <ImagePart imageUrl={src} alt={alt} />,
    [],
  );
  const streamingSegmentation =
    hasCompleteProposedPlan || processedText.includes(PROPOSED_PLAN_START)
      ? "off"
      : "auto";

  return (
    <div>
      {hasCompleteProposedPlan && onOpenInArtifactWorkspace ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mb-2 h-8 gap-2"
          onClick={onOpenInArtifactWorkspace}
        >
          <ExternalLink className="size-3.5" aria-hidden />
          Open plan artifact
        </Button>
      ) : null}
      {showStreamdown && !hasMarkdownSyntax ? (
        <div
          className={cn(
            "whitespace-pre-wrap break-words text-sm leading-relaxed",
            streaming && "streaming-cursor",
          )}
        >
          {processedText}
        </div>
      ) : null}
      {showStreamdown && hasMarkdownSyntax ? (
        <div
          className={cn(
            "prose prose-sm max-w-none",
            streaming && "streaming-cursor",
          )}
          ref={containerRef}
        >
          <MarkdownRenderer
            content={processedText}
            controls={MARKDOWN_CONTROLS}
            streaming={streaming}
            renderImage={renderImage}
            streamingSegmentation={streamingSegmentation}
          />
          {overlays}
        </div>
      ) : null}
    </div>
  );
});

export { TextPart };
