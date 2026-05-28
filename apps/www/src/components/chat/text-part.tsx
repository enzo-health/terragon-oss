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
  /**
   * Opens an in-repo file link in the artifacts panel. Forwarded to the
   * markdown renderer's `onOpenFile`; when absent, links keep their default
   * new-tab behavior. Citations rewritten by `convertCitationsToGitHubLinks`
   * are absolute github.com URLs, so the classifier rejects them and they stay
   * new-tab — coordinating citations with the in-panel preview is a follow-up.
   */
  onOpenRepoFile?: (href: string) => void;
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
const PROPOSED_PLAN_BODY_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/g;
const PROPOSED_PLAN_START_TAG_RE = /<proposed_plan[^>]*>/g;
const POSSIBLE_CODE_BLOCK_RE = /```|~~~|(?:^|\n)(?: {4}|\t)\S/;
const MARKDOWN_SYNTAX_RE =
  /```|~~~|`|\*\*|__|~~|!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\)|(?:^|\n)\s*(?:[-*+]|\d+\.)\s|(?:^|\n)\s{0,3}(?:#{1,6}\s|>|\|)|<[^>\n]+>/;
const STREAMING_MARKDOWN_SYNTAX_RE =
  /```|~~~|\*\*|__|~~|!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\)|(?:^|\n)\s{0,3}(?:#{1,6}\s|>|\|)|<[^>\n]+>/;
const STREAMING_INCREMENTAL_TEXT_UNSAFE_RE =
  /```|~~~|`|\*\*|__|~~|!\[|\]\(|【F:|<|>|\||(?:^|\n)\s{0,3}(?:#{1,6}\s|>|\|)|(?:^|\n)\s*(?:[-*+]|\d+\.)\s|(?:^|\n)(?: {4}|\t)\S/;
const MARKDOWN_CONTROLS = { code: true } satisfies NonNullable<
  ComponentProps<typeof MarkdownRenderer>["controls"]
>;
const MARKDOWN_INCREMENTAL_TAIL_LENGTH = 512;
const STREAMING_APPEND_BOUNDARY_TAIL_LENGTH = 16;

const COLLAPSE_THRESHOLD = 20;
const VISIBLE_LINES = 15;
const LINE_HEIGHT_PX = 22;
const PROPOSED_PLAN_START = "<proposed_plan";
const PROPOSED_PLAN_END = "</proposed_plan>";

interface BlockInfo {
  totalLines: number;
  expanded: boolean;
}

type MarkdownDetectionState = {
  text: string;
  streaming: boolean;
  hasMarkdownSyntax: boolean;
  scanTail: string;
};

type TextProcessingContext = {
  githubRepoFullName?: string;
  branchName?: string;
  baseBranchName?: string;
  hasCheckpoint?: boolean;
  hasArtifactWorkspace: boolean;
};

type TextProcessingState = {
  text: string;
  processedText: string;
  streaming: boolean;
  contextKey: string;
  hasCompleteProposedPlan: boolean;
  hasPossibleCodeBlock: boolean;
  hasProposedPlanStart: boolean;
  usedIncrementalAppend: boolean;
};

type StreamingAppendContext = {
  previous: TextProcessingState;
  suffix: string;
};

function getFirstProposedPlanBody(text: string): string {
  PROPOSED_PLAN_BODY_RE.lastIndex = 0;
  return PROPOSED_PLAN_BODY_RE.exec(text)?.[1]?.trim() ?? "";
}

function getIncompleteProposedPlanDisplayText(text: string): string {
  PROPOSED_PLAN_START_TAG_RE.lastIndex = 0;
  return text.replace(PROPOSED_PLAN_START_TAG_RE, "").trimStart();
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

function getIncrementalMarkdownScanStart(previousText: string): number {
  let start = Math.max(
    0,
    previousText.length - MARKDOWN_INCREMENTAL_TAIL_LENGTH,
  );

  for (const marker of ["\n", "[", "<", "`", "*", "_", "~", "|"]) {
    const markerIndex = previousText.lastIndexOf(marker);
    if (markerIndex >= 0) {
      start = Math.min(start, markerIndex);
    }
  }

  return start;
}

function getMarkdownScanTail(text: string): string {
  return text.slice(-MARKDOWN_INCREMENTAL_TAIL_LENGTH);
}

export function detectMarkdownSyntax({
  text,
  streaming,
  previous,
  knownAppend = false,
}: {
  text: string;
  streaming: boolean;
  previous: MarkdownDetectionState | null;
  knownAppend?: boolean;
}): MarkdownDetectionState {
  const regex = streaming ? STREAMING_MARKDOWN_SYNTAX_RE : MARKDOWN_SYNTAX_RE;

  if (streaming && previous?.streaming === true && previous.hasMarkdownSyntax) {
    return {
      text,
      streaming,
      hasMarkdownSyntax: true,
      scanTail: getMarkdownScanTail(text),
    };
  }

  const canScanIncrementally =
    streaming &&
    previous?.streaming === true &&
    previous.hasMarkdownSyntax === false &&
    text.length >= previous.text.length &&
    (knownAppend || text.startsWith(previous.text));
  const scanText =
    canScanIncrementally && knownAppend
      ? `${previous.scanTail}${text.slice(previous.text.length)}`
      : canScanIncrementally
        ? text.slice(getIncrementalMarkdownScanStart(previous.text))
        : text;

  return {
    text,
    streaming,
    hasMarkdownSyntax: regex.test(scanText),
    scanTail: getMarkdownScanTail(scanText),
  };
}

function getTextProcessingContextKey({
  githubRepoFullName,
  branchName,
  baseBranchName,
  hasCheckpoint,
  hasArtifactWorkspace,
}: TextProcessingContext): string {
  return JSON.stringify({
    githubRepoFullName,
    branchName,
    baseBranchName,
    hasCheckpoint: Boolean(hasCheckpoint),
    hasArtifactWorkspace,
  });
}

function getStreamingAppendContext({
  text,
  streaming,
  previous,
  contextKey,
}: {
  text: string;
  streaming: boolean;
  previous: TextProcessingState | null;
  contextKey: string;
}): StreamingAppendContext | null {
  if (
    !streaming ||
    previous?.streaming !== true ||
    previous.contextKey !== contextKey ||
    text.length < previous.text.length ||
    !text.startsWith(previous.text)
  ) {
    return null;
  }

  return {
    previous,
    suffix: text.slice(previous.text.length),
  };
}

function canUseIncrementalPlainAppend({
  previous,
  suffix,
}: StreamingAppendContext): boolean {
  if (
    previous.hasCompleteProposedPlan ||
    previous.hasPossibleCodeBlock ||
    previous.hasProposedPlanStart
  ) {
    return false;
  }

  if (suffix.length === 0) {
    return true;
  }

  STREAMING_INCREMENTAL_TEXT_UNSAFE_RE.lastIndex = 0;
  return !STREAMING_INCREMENTAL_TEXT_UNSAFE_RE.test(
    `${previous.text.slice(-STREAMING_APPEND_BOUNDARY_TAIL_LENGTH)}${suffix}`,
  );
}

function canUseIncrementalPlanAppend({
  previous,
  suffix,
}: {
  previous: TextProcessingState;
  suffix: string;
}): boolean {
  const planTail = `${previous.text.slice(-PROPOSED_PLAN_END.length)}${suffix}`;
  const citationTail = `${previous.text.slice(-"【F:".length)}${suffix}`;
  return (
    previous.hasProposedPlanStart &&
    !previous.hasCompleteProposedPlan &&
    previous.processedText === previous.text &&
    !planTail.includes(PROPOSED_PLAN_END) &&
    !citationTail.includes("【F:")
  );
}

export function processTextForRendering({
  text,
  streaming,
  previous,
  context,
}: {
  text: string;
  streaming: boolean;
  previous: TextProcessingState | null;
  context: TextProcessingContext;
}): TextProcessingState {
  const contextKey = getTextProcessingContextKey(context);
  const appendContext = getStreamingAppendContext({
    text,
    streaming,
    previous,
    contextKey,
  });
  const appendPrevious = appendContext?.previous ?? null;
  const suffix = appendContext?.suffix ?? "";
  if (appendContext && canUseIncrementalPlainAppend(appendContext)) {
    return {
      ...appendContext.previous,
      text,
      processedText: appendContext.previous.processedText + suffix,
      usedIncrementalAppend: true,
    };
  }

  if (
    appendPrevious &&
    canUseIncrementalPlanAppend({ previous: appendPrevious, suffix })
  ) {
    return {
      ...appendPrevious,
      text,
      processedText: appendPrevious.processedText + suffix,
      hasProposedPlanStart: true,
      usedIncrementalAppend: true,
    };
  }

  const hasProposedPlanStart = appendPrevious
    ? appendPrevious.hasProposedPlanStart ||
      `${appendPrevious.text.slice(-PROPOSED_PLAN_START.length)}${suffix}`.includes(
        PROPOSED_PLAN_START,
      )
    : text.includes(PROPOSED_PLAN_START);
  const hasCompleteProposedPlan =
    hasProposedPlanStart &&
    (appendPrevious && streaming
      ? appendPrevious.hasCompleteProposedPlan ||
        `${appendPrevious.text.slice(-PROPOSED_PLAN_END.length)}${suffix}`.includes(
          PROPOSED_PLAN_END,
        )
      : (() => {
          PROPOSED_PLAN_RE.lastIndex = 0;
          return PROPOSED_PLAN_RE.test(text);
        })());
  const hasPossibleCodeBlock = !streaming && POSSIBLE_CODE_BLOCK_RE.test(text);
  let processedText = normalizeBoldHeaders(
    convertCitationsToGitHubLinks(
      text,
      context.githubRepoFullName,
      context.branchName,
      context.baseBranchName,
      context.hasCheckpoint,
    ),
  );

  if (hasCompleteProposedPlan && context.hasArtifactWorkspace) {
    PROPOSED_PLAN_RE.lastIndex = 0;
    const withoutPlan = processedText.replace(PROPOSED_PLAN_RE, "").trim();
    processedText =
      withoutPlan.length > 0
        ? withoutPlan
        : getFirstProposedPlanBody(processedText);
  }

  return {
    text,
    processedText,
    streaming,
    contextKey,
    hasCompleteProposedPlan,
    hasPossibleCodeBlock,
    hasProposedPlanStart,
    usedIncrementalAppend: false,
  };
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
  onOpenRepoFile,
}: TextPartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [blocks, setBlocks] = useState<Map<number, BlockInfo>>(new Map());
  // Track scan results separately from expand state to avoid re-scan loops
  const lastScanRef = useRef<string>("");
  const markdownDetectionRef = useRef<MarkdownDetectionState | null>(null);
  const textProcessingRef = useRef<TextProcessingState | null>(null);
  const processed = useMemo(() => {
    const nextProcessed = processTextForRendering({
      text,
      streaming,
      previous: textProcessingRef.current,
      context: {
        githubRepoFullName,
        branchName,
        baseBranchName,
        hasCheckpoint,
        hasArtifactWorkspace: Boolean(onOpenInArtifactWorkspace),
      },
    });
    textProcessingRef.current = nextProcessed;
    return nextProcessed;
  }, [
    text,
    streaming,
    githubRepoFullName,
    branchName,
    baseBranchName,
    hasCheckpoint,
    onOpenInArtifactWorkspace,
  ]);
  const {
    processedText,
    hasCompleteProposedPlan,
    hasPossibleCodeBlock,
    hasProposedPlanStart,
    usedIncrementalAppend,
  } = processed;
  const canScanCodeBlocks = shouldScanCodeBlocks({
    hasPossibleCodeBlock,
    streaming,
  });

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
  }, [blocks, toggleBlock]);

  const renderIncompletePlanAsPlain =
    streaming && hasProposedPlanStart && !hasCompleteProposedPlan;
  const visibleText = renderIncompletePlanAsPlain
    ? getIncompleteProposedPlanDisplayText(processedText)
    : processedText;
  const showStreamdown = visibleText.length > 0;
  const hasMarkdownSyntax = useMemo(() => {
    if (renderIncompletePlanAsPlain) return false;
    const detection = detectMarkdownSyntax({
      text: processedText,
      streaming,
      previous: markdownDetectionRef.current,
      knownAppend: usedIncrementalAppend,
    });
    markdownDetectionRef.current = detection;
    return detection.hasMarkdownSyntax;
  }, [
    processedText,
    renderIncompletePlanAsPlain,
    streaming,
    usedIncrementalAppend,
  ]);
  const renderImage = useCallback(
    (src: string, alt?: string) => <ImagePart imageUrl={src} alt={alt} />,
    [],
  );
  const streamingSegmentation =
    hasCompleteProposedPlan || hasProposedPlanStart ? "off" : "auto";

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
            "whitespace-pre-wrap break-words text-[length:var(--text-fluid-base)] leading-relaxed",
            streaming && "streaming-cursor",
          )}
        >
          {visibleText}
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
            content={visibleText}
            controls={MARKDOWN_CONTROLS}
            streaming={streaming}
            renderImage={renderImage}
            onOpenFile={onOpenRepoFile}
            streamingSegmentation={streamingSegmentation}
          />
          {overlays}
        </div>
      ) : null}
    </div>
  );
});

export { TextPart };
