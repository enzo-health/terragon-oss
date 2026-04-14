import type { Story, StoryDefault } from "@ladle/react";
import { UsageChip } from "./usage-chip";
import { RateLimitChip } from "./rate-limit-chip";
import { ModelRoutingChip } from "./model-routing-chip";
import { McpServerHealthChip } from "./mcp-server-health-chip";

export default {
  title: "Chat/MetaChips",
} satisfies StoryDefault;

export const UsageActive: Story = () => (
  <div className="p-4 flex gap-2 flex-wrap">
    <UsageChip
      tokenUsage={{
        inputTokens: 12000,
        cachedInputTokens: 2000,
        outputTokens: 8000,
      }}
    />
  </div>
);

export const UsageWarning: Story = () => (
  <div className="p-4 flex gap-2 flex-wrap">
    <UsageChip
      tokenUsage={{
        inputTokens: 50000,
        cachedInputTokens: 0,
        outputTokens: 90000,
      }}
    />
  </div>
);

export const RateLimitActive: Story = () => (
  <div className="p-4 flex gap-2 flex-wrap">
    <RateLimitChip
      rateLimits={{ requests_remaining: 900, requests_limit: 1000 }}
    />
  </div>
);

export const RateLimitWarning: Story = () => (
  <div className="p-4 flex gap-2 flex-wrap">
    <RateLimitChip
      rateLimits={{ requests_remaining: 10, requests_limit: 100 }}
    />
  </div>
);

export const ModelRerouted: Story = () => (
  <div className="p-4 flex gap-2 flex-wrap">
    <ModelRoutingChip
      modelReroute={{
        originalModel: "claude-opus-4",
        reroutedModel: "claude-sonnet-4-5",
        reason: "context window exceeded",
      }}
    />
  </div>
);

export const McpServers: Story = () => (
  <div className="p-4 flex gap-2 flex-wrap">
    <McpServerHealthChip
      mcpServerStatus={{
        "file-system": "ready",
        "web-search": "loading",
        database: "error",
      }}
    />
  </div>
);

export const AllChips: Story = () => (
  <div className="p-4 flex gap-2 flex-wrap items-center">
    <UsageChip
      tokenUsage={{
        inputTokens: 12000,
        cachedInputTokens: 2000,
        outputTokens: 8000,
      }}
    />
    <RateLimitChip
      rateLimits={{ requests_remaining: 10, requests_limit: 100 }}
    />
    <ModelRoutingChip
      modelReroute={{
        originalModel: "claude-opus-4",
        reroutedModel: "claude-sonnet-4-5",
        reason: "budget",
      }}
    />
    <McpServerHealthChip mcpServerStatus={{ "tools-server": "ready" }} />
  </div>
);
