import { ClaudeMessage } from "@terragon/daemon/shared";
import { TZDate } from "@date-fns/tz";

// Helper function to parse time in format "3pm" to reset timestamp
function parseHourlyResetTime(
  hourStr: string,
  amPm: string,
  timezone: string,
): number {
  const hour = parseInt(hourStr, 10);
  const isPM = amPm === "pm";

  // Convert to 24-hour format
  let hour24 = hour;
  if (isPM && hour !== 12) {
    hour24 = hour + 12;
  } else if (!isPM && hour === 12) {
    hour24 = 0;
  }

  // Get current time
  const now = new Date();
  // Get the current time in the target timezone
  const tzNow = new TZDate(now, timezone);
  // Create reset time at the target hour
  let resetTime = new TZDate(now, timezone);
  resetTime.setHours(hour24, 0, 0, 0);
  // If the target hour has already passed today, schedule for tomorrow
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
  // Old format: "Claude AI usage limit reached|1752350400"
  const rateLimitMatch = result.match(/^Claude AI usage limit reached\|(\d+)$/);
  if (rateLimitMatch && rateLimitMatch[1]) {
    return {
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: parseInt(rateLimitMatch[1], 10) * 1000, // Convert to milliseconds
    };
  }

  // Format: "5-hour limit reached ∙ resets 3pm"
  // Format: "Session limit reached ∙ resets 3pm"
  // Format: "5-hour limit reached · resets 11am (UTC) · /upgrade to Max 20x or turn on /extra-usage"
  // Format: "Limit reached · resets 3pm (UTC) · ..."
  // Format: "Usage limit reached · resets 3pm (UTC) · ..."
  const hourOrSessionLimitMatch = result.match(
    /^(\d+-hour limit reached|Session limit reached|Limit reached|Usage limit reached)(?: [∙·] resets (\d{1,2})(am|pm)(?: \(UTC\))?)?(?:.*)?$/,
  );
  if (hourOrSessionLimitMatch) {
    const timeStr = hourOrSessionLimitMatch[2];
    const amPmStr = hourOrSessionLimitMatch[3];
    // If (UTC) is specified in the message, use UTC timezone; otherwise use provided timezone
    const hasUtcTimezone = result.includes("(UTC)");
    const effectiveTimezone = hasUtcTimezone ? "UTC" : timezone;
    const resetTimeOrNull =
      timeStr && amPmStr
        ? parseHourlyResetTime(timeStr, amPmStr, effectiveTimezone)
        : null;
    return {
      isRateLimited: true,
      // Only ambiguous if we have a reset time but no explicit timezone in the message
      timezoneIsAmbiguous: !!resetTimeOrNull && !hasUtcTimezone,
      rateLimitResetTime: resetTimeOrNull,
    };
  }

  // Format: "Weekly limit reached" or "Opus weekly limit reached" or "Sonnet weekly limit reached" with optional reset info
  // Can have formats like:
  // - "Weekly limit reached"
  // - "Weekly limit reached ∙ resets 6pm"
  // - "Weekly limit reached · resets 6pm (UTC) · /upgrade to Max..."
  // - "Weekly limit reached ∙ resets Mon 10am"
  // - "Sonnet weekly limit reached · resets 3pm (UTC)"
  // - "Opus weekly limit reached · resets 3pm (UTC)"
  const weeklyLimitMatch = result.match(
    /^(?:Opus |Sonnet )?[Ww]eekly limit reached(?: [∙·] resets (\d{1,2})(am|pm)(?: \(UTC\))?)?(?:.*)?$/,
  );
  if (weeklyLimitMatch) {
    const timeStr = weeklyLimitMatch[1];
    const amPmStr = weeklyLimitMatch[2];
    // If (UTC) is specified in the message, use UTC timezone; otherwise use provided timezone
    const hasUtcTimezone = result.includes("(UTC)");
    const effectiveTimezone = hasUtcTimezone ? "UTC" : timezone;
    const resetTimeOrNull =
      timeStr && amPmStr
        ? parseHourlyResetTime(timeStr, amPmStr, effectiveTimezone)
        : null;
    return {
      isRateLimited: true,
      // Only ambiguous if we have a reset time but no explicit timezone in the message
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
  message: ClaudeMessage;
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

export function parseClaudeOverloadedMessage(message: ClaudeMessage): boolean {
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
  message: ClaudeMessage,
): boolean {
  if (message.type !== "result") {
    return false;
  }

  if (message.subtype !== "success") {
    return false;
  }

  if (
    message.result.includes("input length and max_tokens exceed context limit")
  ) {
    return true;
  }

  if (message.is_error && message.result === "Prompt is too long") {
    return true;
  }

  return false;
}

export function parseCodexErrorMessage(message: ClaudeMessage): null | string {
  if (
    message.type === "result" &&
    message.subtype === "success" &&
    message.result.startsWith("Codex error:")
  ) {
    return message.result;
  }

  return null;
}

// Helper function to parse Codex duration strings (e.g., "11 hours 46 minutes")
// Returns the duration in milliseconds
// Handles two patterns:
// 1. Pro/Enterprise/Edu: "Try again in {duration}."
// 2. Plus/Team/Business: "or try again in {duration}."
function parseCodexDuration(durationStr: string): number | null {
  // Handle "less than a minute"
  if (durationStr.includes("less than a minute")) {
    return 60 * 1000; // 1 minute in milliseconds
  }

  // Parse pattern: Must match at least one time component
  // Format: "(Try again in|or try again in) [days]? [hours]? [minutes]?[.]"
  //  where at least one component must be present
  const match = durationStr.match(
    /(?:Try again in|or try again in) (?:(\d+) days?)?(?: )?(?:(\d+) hours?)?(?: )?(?:(\d+) minutes?|less than a minute)?/,
  );

  if (!match) {
    return null;
  }

  const days = match[1] ? parseInt(match[1], 10) : 0;
  const hours = match[2] ? parseInt(match[2], 10) : 0;
  const minutes = match[3] ? parseInt(match[3], 10) : 0;

  // At least one component must be present (non-zero)
  if (days === 0 && hours === 0 && minutes === 0) {
    return null;
  }

  // Convert to milliseconds
  const totalMs =
    days * 24 * 60 * 60 * 1000 + hours * 60 * 60 * 1000 + minutes * 60 * 1000;

  return totalMs > 0 ? totalMs : null;
}

export function parseCodexRateLimitMessageStr(
  result: string,
): RateLimitResult | null {
  if (!result) {
    return null;
  }

  // All Codex rate limit messages start with this prefix
  if (!result.startsWith("You've hit your usage limit.")) {
    return null;
  }

  // Try to parse duration for other plan types
  // Formats:
  // - Or: "You've hit your usage limit. Try again in {duration}."
  // - Team/Business: "You've hit your usage limit. To get more access now, send a request to your admin or try again in {duration}."
  const durationMs = parseCodexDuration(result);

  if (durationMs === null) {
    // Rate limited but can't parse the duration
    return {
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    };
  }

  // Calculate reset time from current time + duration
  const resetTime = Date.now() + durationMs;

  return {
    isRateLimited: true,
    timezoneIsAmbiguous: false,
    rateLimitResetTime: resetTime,
  };
}

export function parseCodexRateLimitMessage(
  message: ClaudeMessage,
): RateLimitResult | null {
  if (message.type !== "result") {
    return null;
  }

  // Handle both success and error_during_execution subtypes
  if (message.subtype === "success" && message.result) {
    return parseCodexRateLimitMessageStr(message.result);
  }

  if (message.subtype === "error_during_execution" && message.error) {
    return parseCodexRateLimitMessageStr(message.error);
  }

  return null;
}

export function parseClaudeOAuthTokenRevokedMessage(
  message: ClaudeMessage,
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
