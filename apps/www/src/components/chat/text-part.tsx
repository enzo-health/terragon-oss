import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import "streamdown/styles.css";
import { ImagePart } from "./image-part";

interface TextPartProps {
  text: string;
  githubRepoFullName?: string;
  branchName?: string;
  baseBranchName?: string;
  hasCheckpoint?: boolean;
}

const codePlugin = createCodePlugin({
  themes: ["github-light", "one-dark-pro"],
});

const plugins = { code: codePlugin };

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

const TextPart = memo(function TextPart({
  text,
  githubRepoFullName,
  branchName,
  baseBranchName,
  hasCheckpoint,
}: TextPartProps) {
  const processedText = normalizeBoldHeaders(
    convertCitationsToGitHubLinks(
      text,
      githubRepoFullName,
      branchName,
      baseBranchName,
      hasCheckpoint,
    ),
  );

  const components = useMemo(
    () => ({
      code({ children, ...props }: any) {
        return (
          <code
            className="bg-muted text-foreground px-1.5 py-0.5 rounded text-sm font-mono"
            {...props}
          >
            {children}
          </code>
        );
      },
      p({ children }: any) {
        return <p className="mb-2 last:mb-0 text-foreground">{children}</p>;
      },
      ul({ children }: any) {
        return (
          <ul className="list-disc pl-4 mb-2 text-foreground">{children}</ul>
        );
      },
      ol({ children }: any) {
        return (
          <ol className="list-decimal pl-8 mb-2 text-foreground">{children}</ol>
        );
      },
      li({ children }: any) {
        return <li className="mb-1 text-foreground">{children}</li>;
      },
      blockquote({ children }: any) {
        return (
          <blockquote className="border-l-4 border-border pl-4 italic text-muted-foreground my-2">
            {children}
          </blockquote>
        );
      },
      h1({ children }: any) {
        return (
          <h1 className="text-xl font-bold mb-2 text-foreground">{children}</h1>
        );
      },
      h2({ children }: any) {
        return (
          <h2 className="text-lg font-bold mb-2 text-foreground">{children}</h2>
        );
      },
      h3({ children }: any) {
        return (
          <h3 className="text-base font-bold mb-2 text-foreground">
            {children}
          </h3>
        );
      },
      table({ children }: any) {
        return (
          <div className="overflow-x-auto my-2">
            <table className="min-w-full border border-border">
              {children}
            </table>
          </div>
        );
      },
      thead({ children }: any) {
        return <thead className="bg-muted">{children}</thead>;
      },
      th({ children }: any) {
        return (
          <th className="border border-border px-2 py-1 text-left font-medium text-foreground">
            {children}
          </th>
        );
      },
      td({ children }: any) {
        return (
          <td className="border border-border px-2 py-1 text-foreground">
            {children}
          </td>
        );
      },
      a({ children, href, ...props }: any) {
        return (
          <a
            href={href}
            className="underline break-all"
            target="_blank"
            rel="noopener noreferrer"
            {...props}
          >
            {children}
          </a>
        );
      },
      img({ src, alt }: any) {
        if (!src) {
          return null;
        }
        return <ImagePart imageUrl={src as string} alt={alt} />;
      },
      hr() {
        return <hr className="my-4 border-t border-border" />;
      },
    }),
    [],
  );

  return (
    <div className="prose prose-sm max-w-none">
      <Streamdown
        plugins={plugins}
        components={components}
        controls={{ code: true }}
      >
        {processedText}
      </Streamdown>
    </div>
  );
});

export { TextPart };
