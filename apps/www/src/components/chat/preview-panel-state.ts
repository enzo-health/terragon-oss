import type {
  PreviewOpenMode,
  PreviewUnsupportedReason,
} from "@terragon/shared/types/preview";

export type PreviewStage =
  | "idle"
  | "pending"
  | "initializing"
  | "ready"
  | "unsupported"
  | "error";

export type PreviewPanelState = {
  stage: PreviewStage;
  previewSessionId: string | null;
  proxyBasePath: string | null;
  channel: string | null;
  broadcastToken: string | null;
  openMode: PreviewOpenMode;
  unsupportedReason: PreviewUnsupportedReason | null;
  message: string | null;
};

export const INITIAL_PREVIEW_STATE: PreviewPanelState = {
  stage: "idle",
  previewSessionId: null,
  proxyBasePath: null,
  channel: null,
  broadcastToken: null,
  openMode: "iframe",
  unsupportedReason: null,
  message: null,
};

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function readString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readPreviewState(
  payload: Record<string, unknown>,
): Exclude<PreviewStage, "idle"> | null {
  const state = readString(payload, "state");
  if (
    state === "pending" ||
    state === "initializing" ||
    state === "ready" ||
    state === "unsupported" ||
    state === "error"
  ) {
    return state;
  }
  return null;
}

export function readUnsupportedReason(
  payload: Record<string, unknown>,
): PreviewUnsupportedReason | null {
  const reason = readString(payload, "unsupportedReason");
  if (
    reason === "missing_config" ||
    reason === "adapter_unimplemented" ||
    reason === "ws_required" ||
    reason === "frame_bust" ||
    reason === "capability_missing" ||
    reason === "cookie_blocked" ||
    reason === "proxy_denied"
  ) {
    return reason;
  }
  return null;
}

export function getUnsupportedReasonLabel(
  reason: PreviewUnsupportedReason | null,
): string {
  switch (reason) {
    case "ws_required":
      return "Preview requires websocket transport in this run.";
    case "cookie_blocked":
      return "Preview cookies are blocked in iframe mode. Open in a new tab.";
    case "frame_bust":
      return "The upstream app blocked iframe embedding.";
    case "capability_missing":
      return "Preview capability is not available for this environment.";
    case "adapter_unimplemented":
      return "Preview adapter support is not implemented for this provider yet.";
    case "proxy_denied":
      return "Preview proxy validation denied this session.";
    case "missing_config":
      return "Preview is missing required configuration.";
    default:
      return "Preview is unavailable for this run.";
  }
}

export function shouldFallbackToNewTab(
  reason: PreviewUnsupportedReason | null,
): boolean {
  return (
    reason === "ws_required" ||
    reason === "cookie_blocked" ||
    reason === "frame_bust"
  );
}
