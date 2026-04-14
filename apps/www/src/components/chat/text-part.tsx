import dynamic from "next/dynamic";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { ImagePart } from "./image-part";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import {
  parsePlanSpecViewModelFromText,
  parsePartialPlan,
} from "@/lib/delivery-loop-plan-view-model";
import { MarkdownRenderer } from "@/components/ai-elements/markdown-renderer";

const DeliveryLoopPlanReviewCard = dynamic(
  () =>
    import("@/components/patterns/delivery-loop-plan-review-card").then(
      (mod) => mod.DeliveryLoopPlanReviewCard,
    ),
  {
    loading: () => null,
  },
);

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
  return text.replace(/^(\*\*[^*]+\*\*)([A-Za-z])/gm, "$1\n\n$2");
}

const PROPOSED_PLAN_RE = /<proposed_plan>[\s\S]*?<\/proposed_plan>/g;

const COLLAPSE_THRESHOLD = 20;
const VISIBLE_LINES = 15;
const LINE_HEIGHT_PX = 22;

interface BlockInfo {
  totalLines: number;
  expanded: boolean;
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
        "absolute right-0 bottom-0 left-0 z-10 flex items-end justify-center transition-all",
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
        className="pointer-events-auto relative z-20 mb-1 cursor-pointer rounded-md border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
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
  const deliveryPlanReviewCard = useFeatureFlag("deliveryPlanReviewCard");
  // Track scan results separately from expand state to avoid re-scan loops
  const lastScanRef = useRef<string>("");
  const { parsedPlan, isPlanStreaming } = useMemo(() => {
    if (!deliveryPlanReviewCard) {
      return { parsedPlan: null, isPlanStreaming: false };
    }

    const hasOpenTag = /<proposed_plan>/i.test(text);
    const hasCloseTag = /<\/proposed_plan>/i.test(text);

    if (hasOpenTag && !hasCloseTag) {
      return {
        parsedPlan: parsePartialPlan(text),
        isPlanStreaming: true,
      };
    }

    return {
      parsedPlan: parsePlanSpecViewModelFromText(text),
      isPlanStreaming: false,
    };
  }, [deliveryPlanReviewCard, text]);

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
    // Strip the plan XML when we already render a structured card
    if (parsedPlan) {
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
    parsedPlan,
  ]);

  // Scan for collapsible code blocks after DOM updates
  useEffect(() => {
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

    // Run immediately
    runScan();

    // Observe for new code blocks rendered asynchronously (Suspense, lazy highlight)
    // Throttle via requestAnimationFrame to avoid running scanForCodeBlocks
    // hundreds of times per second during agent streaming
    let rafId: number | null = null;
    const throttledScan = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        runScan();
      });
    };
    const observer = new MutationObserver(throttledScan);
    observer.observe(container, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

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
          body.style.maxHeight = "";
          body.style.overflow = "";
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

    const portals: React.ReactNode[] = [];
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

  return (
    <div>
      {parsedPlan ? (
        <DeliveryLoopPlanReviewCard
          plan={parsedPlan}
          className="mb-2"
          isStreaming={isPlanStreaming}
          onOpenInArtifactWorkspace={onOpenInArtifactWorkspace}
        />
      ) : isPlanStreaming ? (
        <DeliveryLoopPlanReviewCard
          plan={{
            title: "",
            summary: "",
            tasks: [],
            assumptions: [],
            source: "proposed_plan_tag",
          }}
          className="mb-2"
          isStreaming
        />
      ) : null}
      {showStreamdown && (
        <div
          className={cn(
            "prose prose-sm max-w-none",
            streaming && "streaming-cursor",
          )}
          ref={containerRef}
        >
          <MarkdownRenderer
            content={processedText}
            controls={{ code: true }}
            streaming={streaming}
            renderImage={(src, alt) => <ImagePart imageUrl={src} alt={alt} />}
          />
          {overlays}
        </div>
      )}
    </div>
  );
});

export { TextPart };
