import { TZDate } from "@date-fns/tz";
import type { RecoverableTerminal } from "./canonical-events";

export interface RecoverableParseMessage {
  type: string;
  subtype?: string;
  result?: string;
  error?: string;
  is_error?: boolean;
  error_info?: string;
}

function parseHourlyResetTime(
  hourStr: string,
  amPm: string,
  timezone: string,
): number {
  const hour = parseInt(hourStr, 10);
  const isPM = amPm === "pm";

  let hour24 = hour;
  if (isPM && hour !== 12) {
    hour24 = hour + 12;
  } else if (!isPM && hour === 12) {
    hour24 = 0;
  }

  const now = new Date();
  const tzNow = new TZDate(now, timezone);
  let resetTime = new TZDate(now, timezone);
  resetTime.setHours(hour24, 0, 0, 0);
  if (resetTime <= tzNow) {
    resetTime.setDate(resetTime.getDate() + 1);
  }
  return resetTime.getTime();
}

type RateLimitResult = {
  isRateLimited: boolean;
  timezoneIsAmbiguous: boolean;
  rateLimitResetTime: number | null;
};

export function parseClaudeRateLimitMessageStr({
  result,
  timezone,
}: {
  result: string;
  timezone: string;
}): RateLimitResult | null {
  if (!result) {
    return null;
  }
  const rateLimitMatch = result.match(/^Claude AI usage limit reached\|(\d+)$/);
  if (rateLimitMatch && rateLimitMatch[1]) {
    return {
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: parseInt(rateLimitMatch[1], 10) * 1000,
    };
  }

  const hourOrSessionLimitMatch = result.match(
    /^(\d+-hour limit reached|Session limit reached|Limit reached|Usage limit reached)(?: [∙·] resets (\d{1,2})(am|pm)(?: \(UTC\))?)?(?:.*)?$/,
  );
  if (hourOrSessionLimitMatch) {
    const timeStr = hourOrSessionLimitMatch[2];
    const amPmStr = hourOrSessionLimitMatch[3];
    const hasUtcTimezone = result.includes("(UTC)");
    const effectiveTimezone = hasUtcTimezone ? "UTC" : timezone;
    const resetTimeOrNull =
      timeStr && amPmStr
        ? parseHourlyResetTime(timeStr, amPmStr, effectiveTimezone)
        : null;
    return {
      isRateLimited: true,
      timezoneIsAmbiguous: !!resetTimeOrNull && !hasUtcTimezone,
      rateLimitResetTime: resetTimeOrNull,
    };
  }

  const weeklyLimitMatch = result.match(
    /^(?:Opus |Sonnet )?[Ww]eekly limit reached(?: [∙·] resets (\d{1,2})(am|pm)(?: \(UTC\))?)?(?:.*)?$/,
  );
  if (weeklyLimitMatch) {
    const timeStr = weeklyLimitMatch[1];
    const amPmStr = weeklyLimitMatch[2];
    const hasUtcTimezone = result.includes("(UTC)");
    const effectiveTimezone = hasUtcTimezone ? "UTC" : timezone;
    const resetTimeOrNull =
      timeStr && amPmStr
        ? parseHourlyResetTime(timeStr, amPmStr, effectiveTimezone)
        : null;
    return {
      isRateLimited: true,
      timezoneIsAmbiguous: !!resetTimeOrNull && !hasUtcTimezone,
      rateLimitResetTime: resetTimeOrNull,
    };
  }

  return null;
}

export function parseClaudeRateLimitMessage({
  message,
  timezone,
}: {
  message: RecoverableParseMessage;
  timezone: string;
}): RateLimitResult | null {
  if (message.type !== "result") {
    return null;
  }
  if (message.subtype !== "success") {
    return null;
  }
  if (message.result) {
    return parseClaudeRateLimitMessageStr({ result: message.result, timezone });
  }
  return null;
}

export function parseClaudeOverloadedMessage(
  message: RecoverableParseMessage,
): boolean {
  if (message.type !== "result") {
    return false;
  }
  if (message.subtype !== "success") {
    return false;
  }
  if (
    message.result &&
    message.result.includes("overloaded_error") &&
    message.result.includes("Please try again later")
  ) {
    return true;
  }
  return false;
}

export function parseClaudePromptTooLongMessage(
  message: RecoverableParseMessage,
): boolean {
  if (message.type !== "result") {
    return false;
  }

  if (message.subtype !== "success") {
    return false;
  }

  if (
    message.result?.includes("input length and max_tokens exceed context limit")
  ) {
    return true;
  }

  if (message.is_error && message.result === "Prompt is too long") {
    return true;
  }

  return false;
}

export function parseContextWindowExhausted(
  message: RecoverableParseMessage,
): boolean {
  if (parseClaudePromptTooLongMessage(message)) {
    return true;
  }

  if (
    message.type === "result" &&
    message.is_error &&
    typeof message.result === "string"
  ) {
    if (
      /context.?length.?exceeded|context.?window|ran out of room|exceeds the context window/i.test(
        message.result,
      )
    ) {
      return true;
    }
  }

  if (message.type === "custom-error") {
    const info = message.error_info ?? null;
    if (
      typeof info === "string" &&
      /context.?length.?exceeded|context.?window|ran out of room|exceeds the context window/i.test(
        info,
      )
    ) {
      return true;
    }
  }

  return false;
}

export function parseCodexErrorMessage(
  message: RecoverableParseMessage,
): null | string {
  if (
    message.type === "result" &&
    message.subtype === "success" &&
    message.result !== undefined &&
    message.result.startsWith("Codex error:")
  ) {
    return message.result;
  }

  return null;
}

function parseCodexDuration(durationStr: string): number | null {
  if (durationStr.includes("less than a minute")) {
    return 60 * 1000;
  }

  const match = durationStr.match(
    /(?:Try again in|or try again in) (?:(\d+) days?)?(?: )?(?:(\d+) hours?)?(?: )?(?:(\d+) minutes?|less than a minute)?/,
  );

  if (!match) {
    return null;
  }

  const days = match[1] ? parseInt(match[1], 10) : 0;
  const hours = match[2] ? parseInt(match[2], 10) : 0;
  const minutes = match[3] ? parseInt(match[3], 10) : 0;

  if (days === 0 && hours === 0 && minutes === 0) {
    return null;
  }

  const totalMs =
    days * 24 * 60 * 60 * 1000 + hours * 60 * 60 * 1000 + minutes * 60 * 1000;

  return totalMs > 0 ? totalMs : null;
}

function parseCodexAbsoluteResetTime(message: string): number | null {
  const match = message.match(/try again at ([^.]+)/i);
  if (!match || !match[1]) {
    return null;
  }
  const cleaned = match[1].trim().replace(/(\d+)(?:st|nd|rd|th)/gi, "$1");
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseCodexRateLimitMessageStr(
  result: string,
): RateLimitResult | null {
  if (!result) {
    return null;
  }

  if (!result.startsWith("You've hit your usage limit.")) {
    return null;
  }

  const durationMs = parseCodexDuration(result);

  if (durationMs !== null) {
    return {
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: Date.now() + durationMs,
    };
  }

  const absoluteResetTime = parseCodexAbsoluteResetTime(result);
  if (absoluteResetTime !== null) {
    return {
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: absoluteResetTime,
    };
  }

  return {
    isRateLimited: true,
    timezoneIsAmbiguous: false,
    rateLimitResetTime: null,
  };
}

export function parseCodexRateLimitMessage(
  message: RecoverableParseMessage,
): RateLimitResult | null {
  if (message.type !== "result") {
    return null;
  }

  if (message.subtype === "success" && message.result) {
    return parseCodexRateLimitMessageStr(message.result);
  }

  if (message.subtype === "error_during_execution" && message.error) {
    return parseCodexRateLimitMessageStr(message.error);
  }

  return null;
}

export function parseClaudeOAuthTokenRevokedMessage(
  message: RecoverableParseMessage,
): boolean {
  if (message.type !== "result") {
    return false;
  }
  if (message.subtype !== "success") {
    return false;
  }
  if (
    message.is_error &&
    message.result &&
    message.result.includes("OAuth token revoked")
  ) {
    return true;
  }
  return false;
}

export function classifyRecoverableTerminal({
  messages,
  agent,
  timezone,
}: {
  messages: RecoverableParseMessage[];
  agent: string | null | undefined;
  timezone: string;
}): RecoverableTerminal | null {
  for (const message of messages) {
    const rateLimit =
      agent === "codex"
        ? parseCodexRateLimitMessage(message)
        : parseClaudeRateLimitMessage({ message, timezone });
    if (rateLimit?.isRateLimited) {
      const retryAfterMs =
        rateLimit.rateLimitResetTime != null
          ? Math.max(0, rateLimit.rateLimitResetTime - Date.now())
          : undefined;
      return {
        kind: "rate-limit",
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    if (parseClaudeOAuthTokenRevokedMessage(message)) {
      return { kind: "oauth-token-revoked" };
    }
    if (parseContextWindowExhausted(message)) {
      return { kind: "context-exhausted" };
    }
  }
  return null;
}
