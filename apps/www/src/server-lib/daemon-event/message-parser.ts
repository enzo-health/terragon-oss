import { ClaudeMessage } from "@terragon/daemon/shared";
import {
  parseClaudeOAuthTokenRevokedMessage,
  parseClaudeRateLimitMessage,
  parseCodexRateLimitMessage,
  parseContextWindowExhausted,
} from "@/agent/msg/helpers";

export const LEGACY_RECOVERABLE_SNIFFER_UNTIL_ALL_DAEMONS_STAMP_RECOVERABLE =
  true;

export function messagesIndicateRecoverableFailure({
  messages,
  agent,
  timezone,
}: {
  messages: ClaudeMessage[];
  agent: string | undefined;
  timezone: string;
}): boolean {
  return messages.some((message) => {
    const isRateLimited =
      agent === "codex"
        ? parseCodexRateLimitMessage(message)?.isRateLimited === true
        : parseClaudeRateLimitMessage({ message, timezone })?.isRateLimited ===
          true;
    return (
      isRateLimited ||
      parseClaudeOAuthTokenRevokedMessage(message) ||
      parseContextWindowExhausted(message)
    );
  });
}
