import { saveClaudeTokens } from "@/agent/msg/claudeCredentials";
import { ClaudeMessage } from "@leo/daemon/shared";

export async function saveClaudeTokensForTest({ userId }: { userId: string }) {
  await saveClaudeTokens({
    userId,
    tokenData: {
      accessToken: "",
      refreshToken: "",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3600 * 1000),
      scope: "",
      isSubscription: true,
    },
  });
}

export function getClaudeResultMessage(): Extract<
  ClaudeMessage,
  { type: "result" }
> {
  return {
    type: "result",
    subtype: "success",
    total_cost_usd: 0.000001,
    duration_ms: 1000,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 1,
    result: "Hello, world!",
    session_id: "test-session-id-1",
  };
}

export function getClaudeRateLimitMessage(
  resetTime: number,
): Extract<ClaudeMessage, { type: "result" }> {
  return {
    type: "result",
    subtype: "success",
    result: `Claude AI usage limit reached|${resetTime}`,
    total_cost_usd: 0.000001,
    duration_ms: 1000,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 1,
    session_id: "test-session-id-1",
  };
}
