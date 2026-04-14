import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageChip } from "./usage-chip";
import { RateLimitChip } from "./rate-limit-chip";
import { ModelRoutingChip } from "./model-routing-chip";
import { McpServerHealthChip } from "./mcp-server-health-chip";

describe("UsageChip", () => {
  it("returns null when no tokenUsage", () => {
    const html = renderToStaticMarkup(<UsageChip tokenUsage={null} />);
    expect(html).toBe("");
  });

  it("renders token total in active state", () => {
    const html = renderToStaticMarkup(
      <UsageChip
        tokenUsage={{
          inputTokens: 1000,
          cachedInputTokens: 200,
          outputTokens: 500,
        }}
      />,
    );
    expect(html).toContain('data-state="active"');
    expect(html).toContain("usage-chip");
  });

  it("renders warning state when output tokens > 80k", () => {
    const html = renderToStaticMarkup(
      <UsageChip
        tokenUsage={{
          inputTokens: 5000,
          cachedInputTokens: 0,
          outputTokens: 85000,
        }}
      />,
    );
    expect(html).toContain('data-state="warning"');
  });
});

describe("RateLimitChip", () => {
  it("returns null when no rateLimits", () => {
    const html = renderToStaticMarkup(<RateLimitChip rateLimits={null} />);
    expect(html).toBe("");
  });

  it("renders active state with non-warning limits", () => {
    const html = renderToStaticMarkup(
      <RateLimitChip
        rateLimits={{ requests_remaining: 900, requests_limit: 1000 }}
      />,
    );
    expect(html).toContain('data-state="active"');
  });

  it("renders warning state when remaining < 20% of limit", () => {
    const html = renderToStaticMarkup(
      <RateLimitChip
        rateLimits={{ requests_remaining: 10, requests_limit: 100 }}
      />,
    );
    expect(html).toContain('data-state="warning"');
  });
});

describe("ModelRoutingChip", () => {
  it("returns null when no reroute", () => {
    const html = renderToStaticMarkup(<ModelRoutingChip modelReroute={null} />);
    expect(html).toBe("");
  });

  it("renders warning chip with rerouted model name", () => {
    const html = renderToStaticMarkup(
      <ModelRoutingChip
        modelReroute={{
          originalModel: "claude-opus-4",
          reroutedModel: "claude-sonnet-4-5",
          reason: "context window exceeded",
        }}
      />,
    );
    expect(html).toContain('data-state="warning"');
    expect(html).toContain("claude-sonnet-4-5");
    expect(html).toContain("model-routing-chip");
  });
});

describe("McpServerHealthChip", () => {
  it("returns null when no servers", () => {
    const html = renderToStaticMarkup(
      <McpServerHealthChip mcpServerStatus={{}} />,
    );
    expect(html).toBe("");
  });

  it("renders loading state", () => {
    const html = renderToStaticMarkup(
      <McpServerHealthChip mcpServerStatus={{ "my-server": "loading" }} />,
    );
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("my-server");
  });

  it("renders ready state", () => {
    const html = renderToStaticMarkup(
      <McpServerHealthChip mcpServerStatus={{ "my-server": "ready" }} />,
    );
    expect(html).toContain('data-state="ready"');
  });

  it("renders error state", () => {
    const html = renderToStaticMarkup(
      <McpServerHealthChip mcpServerStatus={{ "broken-server": "error" }} />,
    );
    expect(html).toContain('data-state="error"');
  });

  it("renders multiple servers", () => {
    const html = renderToStaticMarkup(
      <McpServerHealthChip
        mcpServerStatus={{
          "server-a": "ready",
          "server-b": "error",
        }}
      />,
    );
    expect(html).toContain("server-a");
    expect(html).toContain("server-b");
  });
});
