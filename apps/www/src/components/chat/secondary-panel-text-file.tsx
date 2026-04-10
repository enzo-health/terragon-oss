import React from "react";
import { type UITextFilePart } from "@leo/shared";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ArtifactWorkspaceState } from "./secondary-panel-state";

/** Read at most `maxBytes` from a fetch response body using a stream reader. */
async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback when ReadableStream is unavailable (e.g. mocked fetch in tests).
    const raw = await response.text();
    return raw.length > maxBytes
      ? { text: raw.slice(0, maxBytes), truncated: true }
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
    if (totalBytes > maxBytes) {
      // Decode only the bytes within the cap.
      const excess = totalBytes - maxBytes;
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
  // Flush any remaining bytes from the decoder.
  chunks.push(decoder.decode());
  return { text: chunks.join(""), truncated: false };
}

export function TextFileArtifactRenderer({
  textFilePart,
}: {
  textFilePart: UITextFilePart;
}) {
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
        const response = await fetch(textFilePart.file_url, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Request failed with status ${response.status}`);
        }
        // Cap preview at 512 KB to avoid memory spikes on large generated files.
        // Read via stream to enforce the cap even when content-length is absent.
        const MAX_PREVIEW_BYTES = 512 * 1024;
        const { text, truncated } = await readCappedText(
          response,
          MAX_PREVIEW_BYTES,
        );
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
  }, [textFilePart.file_url]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {textFilePart.filename || "Generated file"}
          </p>
          {textFilePart.mime_type && (
            <p className="text-xs text-muted-foreground">
              {textFilePart.mime_type}
            </p>
          )}
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a
            href={textFilePart.file_url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink className="size-4" />
            Open raw
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
            description={`${state.message} You can still open the raw file.`}
          />
        )}
        {state.status === "ready" && (
          <pre className="min-h-full overflow-auto rounded-xl border bg-muted/40 p-4 text-xs leading-5 text-foreground whitespace-pre-wrap break-words font-mono">
            {state.content}
          </pre>
        )}
      </div>
    </div>
  );
}
