"use client";

import {
  default as React,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { StreamdownProps } from "streamdown";
import "streamdown/styles.css";
import "katex/dist/katex.min.css";
import { CheckIcon, CopyIcon } from "lucide-react";
import { ImagePart } from "@/components/chat/image-part";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const codePlugin = createCodePlugin({
  themes: ["github-light", "one-dark-pro"],
});

const mathPlugin = createMathPlugin();

const plugins = { code: codePlugin, math: mathPlugin };

export type MarkdownVariant = "response" | "reasoning";

type MarkdownRendererProps = {
  content: string;
  streaming?: boolean;
  variant?: MarkdownVariant;
  controls?: StreamdownProps["controls"];
  className?: string;
  renderImage?: (src: string, alt?: string) => ReactNode;
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
      <div className="absolute top-2 left-3 z-10 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
        {language ?? "code"}
      </div>
      <pre
        {...rest}
        className={cn(
          "overflow-x-auto rounded-lg border border-border/50 bg-muted/20 p-3 pt-8 font-mono text-sm",
          className,
        )}
      >
        {children}
      </pre>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute top-2 right-2 z-10 h-7 w-7 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover/code:opacity-70"
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

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  streaming = false,
  variant = "response",
  controls,
  className,
  renderImage,
}: MarkdownRendererProps) {
  const components = useMemo(
    () =>
      variant === "reasoning"
        ? getReasoningComponents()
        : getResponseComponents(renderImage),
    [variant, renderImage],
  );

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
