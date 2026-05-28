"use client";

import {
  memo,
  default as React,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { StreamdownProps } from "streamdown";
import { parseMarkdownIntoBlocks, Streamdown } from "streamdown";
import { createCodePlugin } from "./code-plugin";
import "streamdown/styles.css";
import { CheckIcon, CopyIcon } from "lucide-react";

// KaTeX math plugin (~280 KB JS + 280 KB CSS) is loaded on demand via
// `math-plugin-loader`. The type is pulled in for typing only; the
// dynamic import below is what actually ships the code.
type MathPlugin = ReturnType<
  typeof import("@streamdown/math").createMathPlugin
>;

import { classifyRepoFileLink } from "@terragon/shared/utils/repo-file-link";
import { ImagePart } from "@/components/chat/image-part";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const codePlugin = createCodePlugin({
  themes: ["github-light", "one-dark-pro"],
});

const codeOnlyPlugins = { code: codePlugin };

// Module-singleton promise for the math plugin. Resolved on first demand
// and reused for all subsequent renders — the heavy katex bundle only
// ships once per session, when the first math block is actually seen.
let mathPluginPromise: Promise<MathPlugin> | null = null;
let mathPluginInstance: MathPlugin | null = null;

function ensureMathPlugin(): Promise<MathPlugin> {
  if (mathPluginInstance) return Promise.resolve(mathPluginInstance);
  if (!mathPluginPromise) {
    mathPluginPromise = import("./math-plugin-loader")
      .then((mod) => {
        mathPluginInstance = mod.createMathPlugin();
        return mathPluginInstance;
      })
      .catch((error: unknown) => {
        mathPluginPromise = null;
        throw error;
      });
  }
  return mathPluginPromise;
}

// Cheap detection: we only need to know whether math delimiters appear
// in the current content. The full parsing happens inside remark-math
// when the plugin is active. `$$...$$` is the display-math delimiter
// and is what `@streamdown/math` enables by default
// (singleDollarTextMath defaults to false).
const MATH_RE = /\$\$[\s\S]+?\$\$/;

function contentNeedsMath(content: string): boolean {
  return MATH_RE.test(content);
}

export interface MathDetectionState {
  content: string;
  needsMath: boolean;
  scanTail: string;
}

function getMathScanTail(content: string): string {
  const lastMathDelimiterIndex = content.lastIndexOf("$$");
  if (lastMathDelimiterIndex >= 0) {
    return content.slice(lastMathDelimiterIndex);
  }
  return content.endsWith("$") ? "$" : "";
}

function createMathDetectionState(content: string): MathDetectionState {
  return {
    content,
    needsMath: contentNeedsMath(content),
    scanTail: getMathScanTail(content),
  };
}

export function advanceContentNeedsMath(
  content: string,
  previous: MathDetectionState | null,
): MathDetectionState {
  if (
    !previous ||
    content.length < previous.content.length ||
    !content.startsWith(previous.content)
  ) {
    return createMathDetectionState(content);
  }

  if (previous.needsMath || content.length === previous.content.length) {
    return {
      content,
      needsMath: previous.needsMath,
      scanTail: previous.scanTail,
    };
  }

  const suffix = content.slice(previous.content.length);
  const scanText = previous.scanTail + suffix;
  return {
    content,
    needsMath: contentNeedsMath(scanText),
    scanTail: getMathScanTail(scanText),
  };
}

const MIN_STABLE_MARKDOWN_PREFIX_LENGTH = 480;
const RAW_HTML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>\n]*)?>/;
const REFERENCE_MARKDOWN_RE =
  /(?:^|\n)[ \t]{0,3}\[[^\]\n]+]:[^\n]+|\[[^\]\n]+]\[[^\]\n]*]/;
const UNSAFE_MARKDOWN_SCAN_TAIL_LENGTH = 256;

interface StreamingMarkdownSegments {
  stablePrefix: string;
  liveTail: string;
}

export interface StreamingMarkdownSegmentState
  extends StreamingMarkdownSegments {
  content: string;
  unsafeScanTail: string;
}

type DisabledStreamingMarkdownSegmentationState = {
  content: string;
  unsafeScanTail: string;
};

function hasUnsafeStreamingMarkdown(content: string): boolean {
  return RAW_HTML_TAG_RE.test(content) || REFERENCE_MARKDOWN_RE.test(content);
}

function getUnsafeStreamingMarkdownScanTail(content: string): string {
  return content.slice(-UNSAFE_MARKDOWN_SCAN_TAIL_LENGTH);
}

function createStreamingMarkdownSegmentState(
  content: string,
): StreamingMarkdownSegmentState | null {
  if (content.length < MIN_STABLE_MARKDOWN_PREFIX_LENGTH) return null;
  if (hasUnsafeStreamingMarkdown(content)) return null;

  const blocks = parseMarkdownIntoBlocks(content);
  if (blocks.length < 2) return null;

  const liveTail = blocks.at(-1) ?? "";
  if (liveTail.trim().length === 0) return null;

  const stablePrefix = blocks.slice(0, -1).join("");
  if (stablePrefix.length < MIN_STABLE_MARKDOWN_PREFIX_LENGTH) return null;

  return {
    content,
    stablePrefix,
    liveTail,
    unsafeScanTail: getUnsafeStreamingMarkdownScanTail(content),
  };
}

export function advanceStreamingMarkdownSegments(
  content: string,
  previous: StreamingMarkdownSegmentState | null,
): StreamingMarkdownSegmentState | null {
  if (!previous) {
    return createStreamingMarkdownSegmentState(content);
  }

  if (content.length < previous.content.length) {
    return createStreamingMarkdownSegmentState(content);
  }

  if (!content.startsWith(previous.content)) {
    return createStreamingMarkdownSegmentState(content);
  }

  const suffix = content.slice(previous.content.length);
  const unsafeScanText = previous.unsafeScanTail + suffix;
  if (hasUnsafeStreamingMarkdown(unsafeScanText)) {
    return null;
  }

  if (suffix.length === 0) return previous;

  const tailBlocks = parseMarkdownIntoBlocks(previous.liveTail + suffix);
  const liveTail = tailBlocks.at(-1) ?? "";
  if (tailBlocks.length < 2 || liveTail.trim().length === 0) {
    return {
      content,
      stablePrefix: previous.stablePrefix,
      liveTail: previous.liveTail + suffix,
      unsafeScanTail: getUnsafeStreamingMarkdownScanTail(unsafeScanText),
    };
  }

  return {
    content,
    stablePrefix: previous.stablePrefix + tailBlocks.slice(0, -1).join(""),
    liveTail,
    unsafeScanTail: getUnsafeStreamingMarkdownScanTail(unsafeScanText),
  };
}

export function splitStreamingMarkdownContent(
  content: string,
): StreamingMarkdownSegments | null {
  const segments = createStreamingMarkdownSegmentState(content);
  if (!segments) return null;
  return {
    stablePrefix: segments.stablePrefix,
    liveTail: segments.liveTail,
  };
}

function advanceDisabledStreamingMarkdownSegmentation(
  content: string,
  previous: DisabledStreamingMarkdownSegmentationState | null,
): DisabledStreamingMarkdownSegmentationState | null {
  if (!previous) return null;
  if (
    content.length < previous.content.length ||
    !content.startsWith(previous.content)
  ) {
    return null;
  }
  const suffix = content.slice(previous.content.length);
  return {
    content,
    unsafeScanTail: getUnsafeStreamingMarkdownScanTail(
      previous.unsafeScanTail + suffix,
    ),
  };
}

function advanceStreamingMarkdownSegmentsForRender({
  content,
  previousSegments,
  previousDisabled,
}: {
  content: string;
  previousSegments: StreamingMarkdownSegmentState | null;
  previousDisabled: DisabledStreamingMarkdownSegmentationState | null;
}): {
  segments: StreamingMarkdownSegmentState | null;
  disabled: DisabledStreamingMarkdownSegmentationState | null;
} {
  const disabled = advanceDisabledStreamingMarkdownSegmentation(
    content,
    previousDisabled,
  );
  if (disabled) {
    return { segments: null, disabled };
  }

  const segments = advanceStreamingMarkdownSegments(content, previousSegments);
  if (
    segments ||
    !previousSegments ||
    !content.startsWith(previousSegments.content)
  ) {
    return { segments, disabled: null };
  }

  return {
    segments: null,
    disabled: {
      content,
      unsafeScanTail: getUnsafeStreamingMarkdownScanTail(content),
    },
  };
}

export type MarkdownVariant = "response" | "reasoning";

type MarkdownRendererProps = {
  content: string;
  streaming?: boolean;
  variant?: MarkdownVariant;
  controls?: StreamdownProps["controls"];
  className?: string;
  renderImage?: (src: string, alt?: string) => ReactNode;
  streamingSegmentation?: "auto" | "off";
  /**
   * Called when a link that classifies as an in-repo file path is clicked.
   * When provided, such links open the file preview in-app instead of
   * navigating; external links fall back to normal navigation.
   */
  onOpenFile?: (href: string) => void;
};

function getChildren(props: unknown): ReactNode {
  if (typeof props !== "object" || props === null || !("children" in props)) {
    return undefined;
  }
  return (props as { children?: ReactNode }).children;
}

function getStringProp(
  props: unknown,
  key: "href" | "src" | "alt" | "className",
): string | undefined {
  if (typeof props !== "object" || props === null || !(key in props)) {
    return undefined;
  }
  const value = (props as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getTextContent(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) {
    return node.map(getTextContent).join("");
  }
  if (typeof node === "object" && "props" in node) {
    const childNode = (node as { props?: { children?: ReactNode } }).props
      ?.children;
    return getTextContent(childNode);
  }
  return "";
}

function getLanguageLabel(className?: string): string | null {
  if (!className) return null;
  const match = className.match(/language-([a-z0-9_+-]+)/i);
  if (!match) return null;
  return match[1] ?? null;
}

function findNestedClassName(node: ReactNode): string | null {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNestedClassName(child);
      if (found) return found;
    }
    return null;
  }
  if (typeof node === "object" && "props" in node) {
    const typed = node as {
      props?: { className?: unknown; children?: ReactNode };
    };
    if (typeof typed.props?.className === "string") {
      return typed.props.className;
    }
    return findNestedClassName(typed.props?.children ?? null);
  }
  return null;
}

function CodeBlockPre(props: unknown) {
  const children = getChildren(props);
  const className = getStringProp(props, "className");
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const language = useMemo(() => {
    const direct = getLanguageLabel(className);
    if (direct) return direct;
    const nestedClassName = findNestedClassName(children);
    return getLanguageLabel(nestedClassName ?? undefined);
  }, [children, className]);

  const codeText = useMemo(() => getTextContent(children), [children]);

  const onCopy = useCallback(async () => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }
    try {
      await navigator.clipboard.writeText(codeText);
      setIsCopied(true);
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // no-op
    }
  }, [codeText]);

  useEffect(() => {
    return () => {
      window.clearTimeout(timeoutRef.current);
    };
  }, []);

  const baseProps =
    typeof props === "object" && props !== null
      ? (props as Record<string, unknown>)
      : {};

  const {
    children: _children,
    className: _className,
    node: _node,
    ...rest
  } = baseProps;

  return (
    <div className="group/code relative my-3">
      <div className="absolute top-2 left-3 z-10 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider">
        {language ?? "code"}
      </div>
      <pre
        {...rest}
        className={cn(
          "overflow-x-auto rounded-lg border border-border/50 bg-muted/50 p-3 pt-8 font-mono text-sm",
          className,
        )}
      >
        {children}
      </pre>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute top-2 right-2 z-10 h-7 w-7 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover/code:opacity-70 [@media(hover:none)]:opacity-70"
        onClick={onCopy}
        title={isCopied ? "Copied" : "Copy code"}
        aria-label={isCopied ? "Code copied" : "Copy code"}
      >
        {isCopied ? (
          <CheckIcon className="size-4" />
        ) : (
          <CopyIcon className="size-4" />
        )}
      </Button>
    </div>
  );
}

function getResponseComponents(
  renderImage?: (src: string, alt?: string) => ReactNode,
  onOpenFile?: (href: string) => void,
): NonNullable<StreamdownProps["components"]> {
  const components: NonNullable<StreamdownProps["components"]> = {
    pre(props) {
      return <CodeBlockPre {...props} />;
    },
    code(props) {
      const children = getChildren(props);
      const className = getStringProp(props, "className");
      const isBlockCode =
        className?.includes("language-") === true ||
        (typeof children === "string" && children.includes("\n"));
      const baseProps =
        typeof props === "object" && props !== null
          ? (props as Record<string, unknown>)
          : {};
      const {
        children: _children,
        className: _className,
        node: _node,
        ...rest
      } = baseProps;

      if (isBlockCode) {
        return (
          <code {...rest} className={className ?? "whitespace-pre"}>
            {children}
          </code>
        );
      }

      return (
        <code
          {...rest}
          className={cn(
            "rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-foreground",
            className,
          )}
        >
          {children}
        </code>
      );
    },
    p(props) {
      const children = getChildren(props);
      return <p className="mb-2 last:mb-0 text-foreground">{children}</p>;
    },
    ul(props) {
      const children = getChildren(props);
      return (
        <ul className="list-disc pl-4 mb-2 text-foreground">{children}</ul>
      );
    },
    ol(props) {
      const children = getChildren(props);
      return (
        <ol className="list-decimal pl-8 mb-2 text-foreground">{children}</ol>
      );
    },
    li(props) {
      const children = getChildren(props);
      return <li className="mb-1 text-foreground">{children}</li>;
    },
    blockquote(props) {
      const children = getChildren(props);
      return (
        <blockquote className="border-l-4 border-border pl-4 italic text-muted-foreground my-2">
          {children}
        </blockquote>
      );
    },
    h1(props) {
      const children = getChildren(props);
      return (
        <h1 className="text-xl font-bold mb-2 text-foreground">{children}</h1>
      );
    },
    h2(props) {
      const children = getChildren(props);
      return (
        <h2 className="text-lg font-bold mb-2 text-foreground">{children}</h2>
      );
    },
    h3(props) {
      const children = getChildren(props);
      return (
        <h3 className="text-base font-bold mb-2 text-foreground">{children}</h3>
      );
    },
    table(props) {
      const children = getChildren(props);
      return (
        <div className="overflow-x-auto my-2">
          <table className="min-w-full border border-border">{children}</table>
        </div>
      );
    },
    thead(props) {
      const children = getChildren(props);
      return <thead className="bg-muted">{children}</thead>;
    },
    th(props) {
      const children = getChildren(props);
      return (
        <th className="border border-border px-2 py-1 text-left font-medium text-foreground">
          {children}
        </th>
      );
    },
    td(props) {
      const children = getChildren(props);
      return (
        <td className="border border-border px-2 py-1 text-foreground">
          {children}
        </td>
      );
    },
    a(props) {
      const children = getChildren(props);
      const href = getStringProp(props, "href");
      const repoFileLink =
        onOpenFile && href ? classifyRepoFileLink(href) : null;
      if (onOpenFile && href && repoFileLink) {
        return (
          <a
            href={href}
            className="underline break-all"
            onClick={(event) => {
              event.preventDefault();
              onOpenFile(href);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          href={href}
          className="underline break-all"
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
    img(props) {
      const src = getStringProp(props, "src");
      const alt = getStringProp(props, "alt");
      if (!src) {
        return null;
      }
      if (renderImage) {
        return renderImage(src, alt);
      }
      return <ImagePart imageUrl={src} alt={alt} />;
    },
    hr() {
      return <hr className="my-4 border-t border-border" />;
    },
  };
  return components;
}

function getReasoningComponents(): NonNullable<StreamdownProps["components"]> {
  const components: NonNullable<StreamdownProps["components"]> = {
    p(props) {
      const children = getChildren(props);
      return <p className="mb-2 last:mb-0 break-all">{children}</p>;
    },
    ul(props) {
      const children = getChildren(props);
      return <ul className="list-disc pl-4 mb-2 break-all">{children}</ul>;
    },
    ol(props) {
      const children = getChildren(props);
      return <ol className="list-decimal pl-4 mb-2 break-all">{children}</ol>;
    },
    li(props) {
      const children = getChildren(props);
      return <li className="mb-1 break-all">{children}</li>;
    },
    code(props) {
      const children = getChildren(props);
      const className = getStringProp(props, "className");
      const isBlockCode =
        className?.includes("language-") === true ||
        (typeof children === "string" && children.includes("\n"));
      const baseProps =
        typeof props === "object" && props !== null
          ? (props as Record<string, unknown>)
          : {};
      const {
        children: _children,
        className: _className,
        node: _node,
        ...rest
      } = baseProps;

      if (isBlockCode) {
        return (
          <code {...rest} className={className ?? "whitespace-pre"}>
            {children}
          </code>
        );
      }

      return (
        <code
          {...rest}
          className={cn(
            "break-all rounded bg-background/50 px-1 py-0.5 font-mono text-xs",
            className,
          )}
        >
          {children}
        </code>
      );
    },
    blockquote(props) {
      const children = getChildren(props);
      return (
        <blockquote className="border-l-2 border-border pl-3 italic my-2">
          {children}
        </blockquote>
      );
    },
  };
  return components;
}

const MemoizedStableMarkdownPrefix = memo(
  function MemoizedStableMarkdownPrefix({
    stablePrefix,
    plugins,
    components,
    controls,
    className,
  }: {
    stablePrefix: string;
    plugins: NonNullable<StreamdownProps["plugins"]>;
    components: NonNullable<StreamdownProps["components"]>;
    controls: StreamdownProps["controls"];
    className?: string;
  }) {
    return (
      <Streamdown
        plugins={plugins}
        components={components}
        controls={controls}
        mode="static"
        parseIncompleteMarkdown={false}
        normalizeHtmlIndentation
        className={cn(className, "[&>*:last-child]:mb-2")}
      >
        {stablePrefix}
      </Streamdown>
    );
  },
);

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  streaming = false,
  variant = "response",
  controls,
  className,
  renderImage,
  streamingSegmentation = "auto",
  onOpenFile,
}: MarkdownRendererProps) {
  const components = useMemo(
    () =>
      variant === "reasoning"
        ? getReasoningComponents()
        : getResponseComponents(renderImage, onOpenFile),
    [variant, renderImage, onOpenFile],
  );

  // Lazy-load the math plugin on demand. The first time `content` contains
  // `$$...$$`, kick off the dynamic import; once resolved, swap plugins so
  // subsequent renders include the math plugin. Non-math content never
  // pays the katex bundle cost.
  const [mathPlugin, setMathPlugin] = useState<MathPlugin | null>(
    () => mathPluginInstance,
  );
  const mathDetectionRef = useRef<MathDetectionState | null>(null);
  const mathDetection = advanceContentNeedsMath(
    content,
    mathDetectionRef.current,
  );
  mathDetectionRef.current = mathDetection;
  const needsMath = mathDetection.needsMath;
  useEffect(() => {
    if (!needsMath || mathPlugin) return;
    let cancelled = false;
    ensureMathPlugin().then((plugin) => {
      if (!cancelled) setMathPlugin(plugin);
    });
    return () => {
      cancelled = true;
    };
  }, [needsMath, mathPlugin]);

  const plugins = useMemo(
    () =>
      mathPlugin ? { code: codePlugin, math: mathPlugin } : codeOnlyPlugins,
    [mathPlugin],
  );
  const streamingSegmentRef = useRef<StreamingMarkdownSegmentState | null>(
    null,
  );
  const disabledStreamingSegmentRef =
    useRef<DisabledStreamingMarkdownSegmentationState | null>(null);
  const streamingSegmentProgress =
    streaming && streamingSegmentation === "auto"
      ? advanceStreamingMarkdownSegmentsForRender({
          content,
          previousSegments: streamingSegmentRef.current,
          previousDisabled: disabledStreamingSegmentRef.current,
        })
      : { segments: null, disabled: null };
  const streamingSegments = streamingSegmentProgress.segments;
  streamingSegmentRef.current = streamingSegments;
  disabledStreamingSegmentRef.current = streamingSegmentProgress.disabled;

  if (streamingSegments) {
    return (
      <>
        <MemoizedStableMarkdownPrefix
          stablePrefix={streamingSegments.stablePrefix}
          plugins={plugins}
          components={components}
          controls={controls}
          className={className}
        />
        <Streamdown
          plugins={plugins}
          components={components}
          controls={controls}
          mode="streaming"
          parseIncompleteMarkdown
          normalizeHtmlIndentation
          className={className}
        >
          {streamingSegments.liveTail}
        </Streamdown>
      </>
    );
  }

  return (
    <Streamdown
      plugins={plugins}
      components={components}
      controls={controls}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      normalizeHtmlIndentation
      className={className}
    >
      {content}
    </Streamdown>
  );
});
