import { ClaudeMessage } from "@terragon/daemon/shared";
import {
  classifyDaemonTerminalErrorCategory,
  hashRuntimeFailureMessage,
  mapDaemonTerminalCategoryToRuntimeFailureCategory,
  RUNTIME_FAILURE_ACTION_TABLE,
  type DaemonTerminalErrorCategory,
  type RuntimeFailureCategory,
} from "@terragon/shared/runtime/failure";
import {
  parseClaudeOAuthTokenRevokedMessage,
  parseClaudeOverloadedMessage,
  parseClaudePromptTooLongMessage,
  parseClaudeRateLimitMessage,
  parseClaudeRateLimitMessageStr,
  parseCodexErrorMessage,
  parseCodexRateLimitMessage,
  parseContextWindowExhausted,
} from "@/agent/msg/helpers";
import type { MessageClassification } from "./types";

export function isFailureRetryable(
  failureCategory: RuntimeFailureCategory,
): boolean {
  const action = RUNTIME_FAILURE_ACTION_TABLE[failureCategory];
  return action !== "blocked";
}

export function deriveTerminalFailureSource(
  messages: ClaudeMessage[],
): "custom-error" | "result" | "custom-stop" | "unknown" | null {
  for (const message of messages) {
    if (message.type === "custom-error") return "custom-error";
    if (message.type === "custom-stop") return "custom-stop";
    if (message.type === "result" && message.is_error) return "result";
  }
  return null;
}

export function deriveDaemonTerminalErrorInfo(messages: ClaudeMessage[]): {
  errorMessage: string | null;
  errorCategory: DaemonTerminalErrorCategory;
} {
  for (const message of messages) {
    if (message.type === "custom-error") {
      const errorMessage = message.error_info ?? null;
      return {
        errorMessage,
        errorCategory: classifyDaemonTerminalErrorCategory(errorMessage),
      };
    }
    if (message.type === "result" && message.is_error) {
      const errorMessage =
        "error" in message && typeof message.error === "string"
          ? message.error
          : null;
      return {
        errorMessage,
        errorCategory: "daemon_result_error",
      };
    }
  }
  return {
    errorMessage: null,
    errorCategory: "unknown",
  };
}

export function buildRunContextFailureUpdates(params: {
  isError: boolean;
  errorMessage: string | null;
  errorCategory: DaemonTerminalErrorCategory;
  terminalReason?: string | null;
  failureSource: "custom-error" | "result" | "custom-stop" | "unknown" | null;
}):
  | {
      failureCategory: RuntimeFailureCategory | null;
      failureSource:
        | "custom-error"
        | "result"
        | "custom-stop"
        | "unknown"
        | null;
      failureRetryable: boolean | null;
      failureSignatureHash: number | null;
      failureTerminalReason: string | null;
    }
  | {} {
  if (!params.isError) {
    return {
      failureCategory: null,
      failureSource: null,
      failureRetryable: null,
      failureSignatureHash: null,
      failureTerminalReason: null,
    };
  }
  const failureCategory = mapDaemonTerminalCategoryToRuntimeFailureCategory(
    params.errorCategory,
    params.errorMessage,
  );
  return {
    failureCategory,
    failureSource: params.failureSource,
    failureRetryable: isFailureRetryable(failureCategory),
    failureSignatureHash:
      params.errorMessage != null
        ? hashRuntimeFailureMessage(params.errorMessage)
        : null,
    failureTerminalReason: params.terminalReason ?? params.errorMessage,
  };
}

export function classifyMessages(params: {
  messages: ClaudeMessage[];
  timezone: string;
  agent: string;
}): {
  classification: MessageClassification;
  mutatedMessages: ClaudeMessage[];
} {
  const { messages, timezone, agent } = params;

  let isStop = false;
  let isDone = false;
  let isError = false;
  let sessionId: string | null = null;
  let durationMs = 0;
  let costUsd = 0;
  let isRateLimited = false;
  let isOverloaded = false;
  let rateLimitResetTime: number | undefined;
  let isPromptTooLong = false;
  let customErrorMessage: string | null = null;
  let isOAuthTokenRevoked = false;

  // Mutate messages in-place for timezone annotation (mirrors original behavior)
  const mutatedMessages = messages;

  for (const message of mutatedMessages) {
    if (message.type === "custom-stop") {
      isStop = true;
      durationMs = message.duration_ms ?? 0;
    }
    if (message.type === "custom-error") {
      isError = true;
      customErrorMessage = message.error_info ?? null;
      durationMs = message.duration_ms ?? 0;
    }
    if (message.type === "result") {
      isDone = true;
      durationMs = message.duration_ms ?? 0;
      costUsd = "total_cost_usd" in message ? message.total_cost_usd : 0;
      if (message.is_error) {
        isError = true;
        customErrorMessage = "error" in message ? message.error : null;
      }
      if (agent === "claudeCode") {
        const rateLimitResult = parseClaudeRateLimitMessage({
          message,
          timezone,
        });
        if (rateLimitResult) {
          isRateLimited = rateLimitResult.isRateLimited;
          rateLimitResetTime = rateLimitResult.rateLimitResetTime ?? undefined;
        }
        const overloadedResult = parseClaudeOverloadedMessage(message);
        if (overloadedResult) {
          isOverloaded = true;
        }

        const promptTooLongResult = parseClaudePromptTooLongMessage(message);
        if (promptTooLongResult) {
          isPromptTooLong = true;
          isError = true;
        }

        const oauthTokenRevokedResult =
          parseClaudeOAuthTokenRevokedMessage(message);
        if (oauthTokenRevokedResult) {
          isOAuthTokenRevoked = true;
          isError = true;
        }
      }
      if (agent === "codex") {
        const codexRateLimitResult = parseCodexRateLimitMessage(message);
        if (codexRateLimitResult) {
          isRateLimited = codexRateLimitResult.isRateLimited;
          rateLimitResetTime =
            codexRateLimitResult.rateLimitResetTime ?? undefined;
        }
        const maybeCodexErrorMessage = parseCodexErrorMessage(message);
        if (maybeCodexErrorMessage) {
          isError = true;
          customErrorMessage = maybeCodexErrorMessage;
        }
      }
      if (!isPromptTooLong && parseContextWindowExhausted(message)) {
        isPromptTooLong = true;
        isError = true;
      }
    }
    if (
      message.type === "custom-error" &&
      parseContextWindowExhausted(message)
    ) {
      isPromptTooLong = true;
    }
    if (message.type === "assistant") {
      if (agent === "claudeCode") {
        const content = message.message.content;
        if (typeof content === "string") {
          const rateLimitResult = parseClaudeRateLimitMessageStr({
            result: content,
            timezone,
          });
          if (rateLimitResult?.timezoneIsAmbiguous) {
            message.message.content += ` (${timezone})`;
          }
        } else if (content.length === 1) {
          const messageStr =
            (content[0]!.type === "text" && content[0]!.text) || "";
          const rateLimitResult = parseClaudeRateLimitMessageStr({
            result: messageStr,
            timezone,
          });
          if (rateLimitResult?.timezoneIsAmbiguous) {
            message.message.content = [
              { type: "text", text: `${messageStr} (${timezone})` },
            ];
          }
        }
      }
    }

    if (!sessionId) {
      if (message.type === "assistant" || message.type === "user") {
        if (message.session_id) {
          sessionId = message.session_id;
        }
      }
    }
  }

  return {
    classification: {
      isStop,
      isDone,
      isError,
      isRateLimited,
      isOverloaded,
      isPromptTooLong,
      isOAuthTokenRevoked,
      rateLimitResetTime,
      customErrorMessage,
      sessionId,
      durationMs,
      costUsd,
    },
    mutatedMessages,
  };
}
