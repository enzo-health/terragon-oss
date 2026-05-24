import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAgentTraceSpan, type AgentTraceSpan } from "./agent-trace";

describe("recordAgentTraceSpan", () => {
  afterEach(() => {
    globalThis.__terragonAgentTraceSink = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does no work when tracing is inactive", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const span = recordAgentTraceSpan({
      traceId: "trace-inactive",
      name: "server.agui.redis.published",
    });

    expect(span).toBeNull();
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("records a span when a sink is installed", () => {
    const spans: AgentTraceSpan[] = [];
    globalThis.__terragonAgentTraceSink = (span) => {
      spans.push(span);
    };

    const span = recordAgentTraceSpan({
      traceId: "trace-active",
      name: "server.agui.redis.published",
      startedAtMs: 10,
      endedAtMs: 25,
      attributes: { published: 2 },
    });

    expect(span).toMatchObject({
      schemaVersion: 1,
      traceId: "trace-active",
      name: "server.agui.redis.published",
      startedAtMs: 10,
      endedAtMs: 25,
      durationMs: 15,
      attributes: { published: 2 },
    });
    expect(spans).toEqual([span]);
  });

  it("allows browser-visible streaming spans", () => {
    const spans: AgentTraceSpan[] = [];
    globalThis.__terragonAgentTraceSink = (span) => {
      spans.push(span);
    };

    recordAgentTraceSpan({
      traceId: "trace-visible",
      name: "browser.agent_text.visible",
      attributes: { messageId: "message-1", textDeltaBytes: 24 },
    });
    recordAgentTraceSpan({
      traceId: "trace-visible",
      name: "browser.agent_text.chunk_gap",
      attributes: { messageId: "message-1", gapMs: 120 },
    });

    expect(spans.map((span) => span.name)).toEqual([
      "browser.agent_text.visible",
      "browser.agent_text.chunk_gap",
    ]);
  });
});
