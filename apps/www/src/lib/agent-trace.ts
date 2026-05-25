import { decodeRunMetadata, getRunMetadataProps } from "./run-metadata";

export type AgentTraceAttribute = boolean | number | string | null;

export type AgentTraceSpanName =
  | "client.prompt.submitted"
  | "client.agui.event.received"
  | "client.ui.projected"
  | "browser.agent_text.visible"
  | "browser.agent_text.chunk_gap"
  | "server.agui.post.received"
  | "server.agui.followup.dispatched"
  | "server.daemon_event.received"
  | "server.daemon_event.canonical.persisted"
  | "server.daemon_event.delta.persisted"
  | "server.agui.event_log.persisted"
  | "server.agui.redis.published"
  | "server.agui.sse.opened"
  | "server.agui.sse.first_frame"
  | "server.agui.sse.closed";

export type AgentTraceSpan = {
  schemaVersion: 1;
  traceId: string;
  spanId: string;
  name: AgentTraceSpanName;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  attributes: Record<string, AgentTraceAttribute>;
};

type AgentTraceSink = (span: AgentTraceSpan) => void;

declare global {
  var __terragonAgentTraceSink: AgentTraceSink | undefined;
}

export function recordAgentTraceSpan(args: {
  traceId: string | null | undefined;
  name: AgentTraceSpanName;
  startedAtMs?: number;
  endedAtMs?: number;
  attributes?: Record<string, AgentTraceAttribute>;
}): AgentTraceSpan | null {
  if (!args.traceId) {
    return null;
  }
  if (!isAgentTraceActive()) {
    return null;
  }
  const endedAtMs = args.endedAtMs ?? nowMs();
  const startedAtMs = args.startedAtMs ?? endedAtMs;
  const span: AgentTraceSpan = {
    schemaVersion: 1,
    traceId: args.traceId,
    spanId: createSpanId(args.name, startedAtMs, endedAtMs),
    name: args.name,
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    attributes: args.attributes ?? {},
  };

  globalThis.__terragonAgentTraceSink?.(span);
  recordBrowserPerformanceMark(span);
  if (isTraceLoggingEnabled()) {
    console.info("[agent-trace]", span);
  }
  return span;
}

function isAgentTraceActive(): boolean {
  return (
    globalThis.__terragonAgentTraceSink !== undefined ||
    isTraceLoggingEnabled() ||
    isBrowserPerformanceTraceEnabled()
  );
}

export function getTraceIdFromAgUiForwardedProps(
  forwardedProps: unknown,
): string | null {
  return decodeRunMetadata(forwardedProps).traceId;
}

export function getTerragonProps(
  forwardedProps: unknown,
): Record<string, unknown> | null {
  return getRunMetadataProps(forwardedProps);
}

function recordBrowserPerformanceMark(span: AgentTraceSpan): void {
  if (
    typeof window === "undefined" ||
    typeof window.performance?.mark !== "function"
  ) {
    return;
  }
  const markName = `terragon.agent_trace.${span.name}.${span.traceId}`;
  window.performance.mark(markName, {
    detail: span,
    startTime: Math.max(0, span.endedAtMs - window.performance.timeOrigin),
  });
  window.dispatchEvent(
    new CustomEvent<AgentTraceSpan>("terragon:agent-trace", { detail: span }),
  );
}

function isBrowserPerformanceTraceEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.performance?.mark === "function" &&
    isTraceLoggingEnabled()
  );
}

function createSpanId(
  name: AgentTraceSpanName,
  startedAtMs: number,
  endedAtMs: number,
): string {
  const random =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${name}:${Math.round(startedAtMs)}:${Math.round(endedAtMs)}:${random}`;
}

function nowMs(): number {
  if (typeof performance !== "undefined") {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

function isTraceLoggingEnabled(): boolean {
  const env =
    typeof process !== "undefined" && typeof process.env !== "undefined"
      ? process.env
      : null;
  return (
    env?.["TERRAGON_AGENT_TRACE"] === "1" ||
    env?.["NEXT_PUBLIC_TERRAGON_AGENT_TRACE"] === "1"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
