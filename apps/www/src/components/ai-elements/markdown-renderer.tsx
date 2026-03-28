"use client";

import { memo, useMemo, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import type { StreamdownProps } from "streamdown";
import "streamdown/styles.css";
import "katex/dist/katex.min.css";
import { ImagePart } from "@/components/chat/image-part";

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
  key: "href" | "src" | "alt",
): string | undefined {
  if (typeof props !== "object" || props === null || !(key in props)) {
    return undefined;
  }
  const value = (props as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function getResponseComponents(
  renderImage?: (src: string, alt?: string) => ReactNode,
): NonNullable<StreamdownProps["components"]> {
  const components: NonNullable<StreamdownProps["components"]> = {
    code(props) {
      const children = getChildren(props);
      return (
        <code className="bg-muted text-foreground px-1.5 py-0.5 rounded text-sm font-mono">
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
      return (
        <code className="bg-background/50 px-1 py-0.5 rounded text-xs font-mono break-all">
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
