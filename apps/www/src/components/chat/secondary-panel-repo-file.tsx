import React, { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { type UIRepoFilePart } from "@terragon/shared";
import { isMarkdownFile } from "@terragon/shared/utils/repo-file-link";
import { MarkdownRenderer } from "@/components/ai-elements/markdown-renderer";
import { Button } from "@/components/ui/button";
import { ArtifactWorkspaceState } from "./secondary-panel-state";

/** Cap preview at 512 KB to match the generated-file renderer and avoid spikes. */
const MAX_PREVIEW_BYTES = 512 * 1024;

function buildRawUrl({
  githubRepoFullName,
  ref,
  path,
}: {
  githubRepoFullName: string;
  ref: string;
  path: string;
}): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${githubRepoFullName}/${ref}/${encodedPath}`;
}

function buildBlobUrl({
  githubRepoFullName,
  ref,
  path,
  lineRange,
}: {
  githubRepoFullName: string;
  ref: string;
  path: string;
  lineRange?: UIRepoFilePart["lineRange"];
}): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const anchor = lineRange
    ? `#L${lineRange.start}${
        lineRange.end !== lineRange.start ? `-L${lineRange.end}` : ""
      }`
    : "";
  return `https://github.com/${githubRepoFullName}/blob/${ref}/${encodedPath}${anchor}`;
}

async function readCappedText(
  response: Response,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const raw = await response.text();
    return raw.length > MAX_PREVIEW_BYTES
      ? { text: raw.slice(0, MAX_PREVIEW_BYTES), truncated: true }
      : { text: raw, truncated: false };
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_PREVIEW_BYTES) {
      const excess = totalBytes - MAX_PREVIEW_BYTES;
      chunks.push(
        decoder.decode(value.slice(0, value.byteLength - excess), {
          stream: false,
        }),
      );
      await reader.cancel();
      return { text: chunks.join(""), truncated: true };
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return { text: chunks.join(""), truncated: false };
}

/**
 * Renders an in-repo file preview. Source files render in a code block; `.md`/
 * `.mdx` render via the markdown renderer. Contents are fetched lazily from the
 * repo's raw GitHub URL at the file's resolved ref (current branch when a
 * checkpoint exists, otherwise the base branch).
 */
export function RepoFileArtifactRenderer({
  repoFilePart,
  githubRepoFullName,
  ref,
}: {
  repoFilePart: UIRepoFilePart;
  githubRepoFullName: string;
  ref: string;
}) {
  const { path, lineRange } = repoFilePart;
  const resolvedRef = repoFilePart.ref ?? ref;
  const isMarkdown = isMarkdownFile(path);
  const blobUrl = buildBlobUrl({
    githubRepoFullName,
    ref: resolvedRef,
    path,
    lineRange,
  });

  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; content: string; isTruncated: boolean }
    | { status: "error"; message: string }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setState({ status: "loading" });
      try {
        const response = await fetch(
          buildRawUrl({ githubRepoFullName, ref: resolvedRef, path }),
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        const { text, truncated } = await readCappedText(response);
        setState({ status: "ready", content: text, isTruncated: truncated });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Unable to load file preview.",
        });
      }
    }

    void load();

    return () => controller.abort();
  }, [githubRepoFullName, resolvedRef, path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{path}</p>
          {lineRange && (
            <p className="text-xs text-muted-foreground">
              Lines {lineRange.start}
              {lineRange.end !== lineRange.start ? `-${lineRange.end}` : ""}
            </p>
          )}
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a href={blobUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" />
            Open on GitHub
          </a>
        </Button>
      </div>
      {state.status === "ready" && state.isTruncated && (
        <div className="flex items-center gap-2 border-b px-4 py-2 bg-amber-50 dark:bg-amber-950/20 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>File preview truncated at 512 KB</span>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto p-4">
        {state.status === "loading" && (
          <ArtifactWorkspaceState
            variant="loading"
            title="Loading preview"
            description="Fetching file contents for preview."
          />
        )}
        {state.status === "error" && (
          <ArtifactWorkspaceState
            variant="error"
            title="Preview unavailable"
            description={`${state.message} You can still open the file on GitHub.`}
          />
        )}
        {state.status === "ready" &&
          (isMarkdown ? (
            <div className="prose prose-sm max-w-none">
              <MarkdownRenderer content={state.content} />
            </div>
          ) : (
            <pre className="min-h-full overflow-auto rounded-xl border bg-muted/40 p-4 text-xs leading-5 text-foreground whitespace-pre-wrap break-words font-mono">
              {state.content}
            </pre>
          ))}
      </div>
    </div>
  );
}
