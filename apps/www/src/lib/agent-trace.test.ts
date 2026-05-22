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
});
