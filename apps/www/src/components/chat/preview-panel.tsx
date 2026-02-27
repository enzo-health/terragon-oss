"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useRealtimePreview } from "@/hooks/useRealtime";
import type { BroadcastPreviewMessage } from "@terragon/types/broadcast";
import { getPrimaryThreadChat } from "@terragon/shared/utils/thread-utils";
import type { ThreadInfoFull } from "@terragon/shared/db/types";
import { ExternalLink, Loader2, RotateCcw } from "lucide-react";
import {
  asRecord,
  getUnsupportedReasonLabel,
  INITIAL_PREVIEW_STATE,
  type PreviewPanelState,
  readPreviewState,
  readString,
  readUnsupportedReason,
  shouldFallbackToNewTab,
} from "./preview-panel-state";

export function PreviewPanel({ thread }: { thread: ThreadInfoFull }) {
  const primaryThreadChat = getPrimaryThreadChat(thread);
  const [preview, setPreview] = useState<PreviewPanelState>(
    INITIAL_PREVIEW_STATE,
  );

  const onPreviewMessage = useCallback((message: BroadcastPreviewMessage) => {
    if (message.eventName !== "v1.preview.session.state_changed") {
      return;
    }

    const data = asRecord(message.data);
    const nextState = readPreviewState(data);
    const nextUnsupportedReason = readUnsupportedReason(data);

    setPreview((current) => {
      if (
        nextState === "ready" ||
        nextState === "unsupported" ||
        nextState === "error"
      ) {
        return {
          ...current,
          stage: nextState,
          unsupportedReason: nextUnsupportedReason ?? current.unsupportedReason,
          openMode:
            shouldFallbackToNewTab(nextUnsupportedReason) ||
            shouldFallbackToNewTab(current.unsupportedReason)
              ? "new_tab"
              : current.openMode,
        };
      }
      return current;
    });
  }, []);

  const { socketReadyState } = useRealtimePreview({
    channel: preview.channel,
    authToken: preview.broadcastToken,
    enabled:
      preview.stage === "ready" &&
      !!preview.channel &&
      !!preview.broadcastToken,
    onMessage: onPreviewMessage,
  });

  const startPreview = useCallback(async () => {
    if (!primaryThreadChat) {
      setPreview({
        ...INITIAL_PREVIEW_STATE,
        stage: "error",
        message: "Missing primary chat context for preview startup.",
      });
      return;
    }

    setPreview({
      ...INITIAL_PREVIEW_STATE,
      stage: "pending",
    });

    try {
      const startResponse = await fetch("/api/internal/preview/session/start", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          threadId: thread.id,
          threadChatId: primaryThreadChat.id,
          openMode: "new_tab",
        }),
      });
      const startPayload = asRecord(await startResponse.json());
      if (!startResponse.ok) {
        throw new Error(
          readString(startPayload, "error") ??
            "Failed to start preview session",
        );
      }

      const previewSessionId = readString(startPayload, "previewSessionId");
      const exchangeToken = readString(startPayload, "exchangeToken");
      const openMode =
        readString(startPayload, "openMode") === "new_tab"
          ? "new_tab"
          : "iframe";
      if (!previewSessionId || !exchangeToken) {
        throw new Error(
          "Preview bootstrap response was missing required fields.",
        );
      }

      setPreview((current) => ({
        ...current,
        stage: "initializing",
        previewSessionId,
        openMode,
      }));

      const exchangeResponse = await fetch(
        `/api/preview/session/${previewSessionId}/exchange`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${exchangeToken}`,
          },
          body: JSON.stringify({
            openMode,
          }),
        },
      );
      const exchangePayload = asRecord(await exchangeResponse.json());
      if (!exchangeResponse.ok) {
        const code = readString(exchangePayload, "code");
        setPreview({
          ...INITIAL_PREVIEW_STATE,
          stage: code === "ws_required" ? "unsupported" : "error",
          previewSessionId,
          unsupportedReason: code === "ws_required" ? "ws_required" : null,
          message:
            readString(exchangePayload, "error") ??
            "Preview exchange failed. Please retry.",
          openMode: code === "ws_required" ? "new_tab" : "iframe",
        });
        return;
      }

      const state = readPreviewState(exchangePayload) ?? "ready";
      const unsupportedReason = readUnsupportedReason(exchangePayload);
      const proxyBasePath = readString(exchangePayload, "proxyBasePath");
      const channel = readString(exchangePayload, "channel");
      const broadcastToken = readString(exchangePayload, "broadcastToken");
      let probedUnsupportedReason = unsupportedReason;

      const probeResponse = await fetch(
        `/api/preview/probe/${previewSessionId}`,
        {
          cache: "no-store",
        },
      );
      if (probeResponse.ok) {
        const probePayload = asRecord(await probeResponse.json());
        if (probePayload.ok !== true) {
          probedUnsupportedReason = readUnsupportedReason({
            unsupportedReason: readString(probePayload, "code"),
          });
        }
      }

      const finalOpenMode =
        shouldFallbackToNewTab(probedUnsupportedReason) ||
        openMode === "new_tab"
          ? "new_tab"
          : "iframe";
      const finalState: PreviewPanelState["stage"] =
        probedUnsupportedReason != null
          ? "unsupported"
          : state === "unsupported" || state === "error" || state === "ready"
            ? state
            : "ready";

      setPreview({
        stage: finalState,
        previewSessionId,
        proxyBasePath,
        channel,
        broadcastToken,
        openMode: finalOpenMode,
        unsupportedReason: probedUnsupportedReason,
        message: null,
      });
    } catch (error) {
      setPreview({
        ...INITIAL_PREVIEW_STATE,
        stage: "error",
        message:
          error instanceof Error ? error.message : "Preview startup failed.",
      });
    }
  }, [primaryThreadChat, thread.id]);

  const openPreviewInNewTab = useCallback(() => {
    if (!preview.proxyBasePath) {
      return;
    }
    window.open(`${preview.proxyBasePath}/`, "_blank", "noopener,noreferrer");
  }, [preview.proxyBasePath]);

  const statusLabel = useMemo(() => {
    if (preview.stage === "pending" || preview.stage === "initializing") {
      return "Starting preview";
    }
    if (preview.stage === "ready") {
      return "Preview ready";
    }
    if (preview.stage === "unsupported") {
      return "Preview unsupported";
    }
    if (preview.stage === "error") {
      return "Preview error";
    }
    return "Preview idle";
  }, [preview.stage]);

  const socketStateNote =
    preview.stage === "ready" && socketReadyState === WebSocket.CLOSED
      ? "Realtime channel disconnected. Restart preview to refresh token."
      : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium">Preview</h2>
            <p className="text-xs text-muted-foreground">{statusLabel}</p>
          </div>
          <Button size="sm" variant="outline" onClick={startPreview}>
            {preview.stage === "pending" || preview.stage === "initializing" ? (
              <Loader2 className="mr-2 size-3 animate-spin" />
            ) : (
              <RotateCcw className="mr-2 size-3" />
            )}
            {preview.stage === "idle" ? "Start" : "Restart"}
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {(preview.stage === "idle" ||
          preview.stage === "pending" ||
          preview.stage === "initializing") && (
          <div className="rounded-lg border bg-muted/20 p-4 text-sm">
            <p className="text-muted-foreground">
              Preview initializes with deterministic lifecycle states and secure
              token exchange.
            </p>
          </div>
        )}
        {preview.stage === "unsupported" && (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm font-medium">
              {getUnsupportedReasonLabel(preview.unsupportedReason)}
            </p>
            {preview.proxyBasePath && (
              <Button size="sm" onClick={openPreviewInNewTab}>
                <ExternalLink className="mr-2 size-3" />
                Open in New Tab
              </Button>
            )}
          </div>
        )}
        {preview.stage === "error" && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {preview.message ?? "Preview failed to initialize."}
          </div>
        )}
        {preview.stage === "ready" && preview.proxyBasePath && (
          <div className="space-y-3">
            {preview.openMode === "new_tab" ? (
              <div className="rounded-lg border p-4">
                <p className="mb-3 text-sm text-muted-foreground">
                  This preview requires opening in a dedicated browser tab.
                </p>
                <Button size="sm" onClick={openPreviewInNewTab}>
                  <ExternalLink className="mr-2 size-3" />
                  Open Preview
                </Button>
              </div>
            ) : (
              <iframe
                src={`${preview.proxyBasePath}/`}
                title="Task preview"
                className={cn(
                  "h-[calc(100vh-220px)] w-full rounded-lg border bg-background",
                )}
                sandbox="allow-forms allow-modals allow-popups allow-scripts"
                onError={() => {
                  setPreview((current) => ({
                    ...current,
                    stage: "unsupported",
                    unsupportedReason: "frame_bust",
                    openMode: "new_tab",
                  }));
                }}
              />
            )}
          </div>
        )}
        {socketStateNote && (
          <p className="mt-3 text-xs text-muted-foreground">
            {socketStateNote}
          </p>
        )}
      </div>
    </div>
  );
}
