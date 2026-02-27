import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  parseClaudeRateLimitMessageStr,
  parseCodexRateLimitMessageStr,
  parseCodexRateLimitMessage,
} from "./helpers";

describe("parseClaudeRateLimitMessage", () => {
  beforeEach(() => {
    // Fix the system time to a known date/time for predictable tests
    // March 15, 2024 at 10:00 AM EST
    const mockDate = new Date("2024-03-15T10:00:00-04:00");
    vi.useFakeTimers();
    vi.setSystemTime(mockDate);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should parse rate limit message and trigger rate limit event", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Claude AI usage limit reached|1752350400",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1752350400000, // Timestamp converted to milliseconds
    });
  });

  it("should parse '5-hour limit reached ∙ resets [time]' message with proper timezone handling", async () => {
    const result1 = parseClaudeRateLimitMessageStr({
      result: "5-hour limit reached ∙ resets 3pm",
      timezone: "America/New_York",
    });
    const expectedResetTime = new Date("2024-03-15T15:00:00-04:00");
    expect(result1).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: true,
      rateLimitResetTime: expectedResetTime.getTime(),
    });

    const result2 = parseClaudeRateLimitMessageStr({
      result: "5-hour limit reached ∙ resets 9am",
      timezone: "America/Los_Angeles",
    });
    const expectedResetTime2 = new Date("2024-03-15T09:00:00-07:00");
    expect(result2).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: true,
      rateLimitResetTime: expectedResetTime2.getTime(),
    });

    const result3 = parseClaudeRateLimitMessageStr({
      result: "5-hour limit reached ∙ resets 12am",
      timezone: "UTC",
    });
    const expectedResetTime3 = new Date("2024-03-16T00:00:00+00:00");
    expect(result3).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: true,
      rateLimitResetTime: expectedResetTime3.getTime(),
    });
  });

  it("should parse 'Session limit reached ∙ resets [time]' message with proper timezone handling", async () => {
    const result1 = parseClaudeRateLimitMessageStr({
      result: "Session limit reached ∙ resets 7pm",
      timezone: "America/New_York",
    });
    const expectedResetTime = new Date("2024-03-15T19:00:00-04:00");
    expect(result1).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: true,
      rateLimitResetTime: expectedResetTime.getTime(),
    });

    const result2 = parseClaudeRateLimitMessageStr({
      result: "Session limit reached ∙ resets 11pm",
      timezone: "America/Los_Angeles",
    });
    const expectedResetTime2 = new Date("2024-03-15T23:00:00-07:00");
    expect(result2).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: true,
      rateLimitResetTime: expectedResetTime2.getTime(),
    });

    const result3 = parseClaudeRateLimitMessageStr({
      result: "Session limit reached ∙ resets 12am",
      timezone: "UTC",
    });
    const expectedResetTime3 = new Date("2024-03-16T00:00:00+00:00");
    expect(result3).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: true,
      rateLimitResetTime: expectedResetTime3.getTime(),
    });
  });

  it("should parse '5-hour limit reached' without reset time", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "5-hour limit reached",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse '5-hour limit reached · resets 11pm (UTC)' with explicit UTC timezone", async () => {
    // Note: Mock time is 2024-03-15T10:00:00-04:00 which is 14:00 UTC
    // So 11pm UTC is still in the future on the same day
    const result = parseClaudeRateLimitMessageStr({
      result:
        "5-hour limit reached · resets 11pm (UTC) · /upgrade to Max 20x or turn on /extra-usage",
      timezone: "America/New_York", // Should be ignored in favor of explicit UTC
    });
    const expectedResetTime = new Date("2024-03-15T23:00:00+00:00");
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false, // Not ambiguous because UTC is explicit
      rateLimitResetTime: expectedResetTime.getTime(),
    });
  });

  it("should parse '5-hour limit reached · resets 3pm (UTC)' with middle dot separator", async () => {
    // Note: Mock time is 2024-03-15T10:00:00-04:00 which is 14:00 UTC
    // So 3pm UTC (15:00) is still in the future
    const result = parseClaudeRateLimitMessageStr({
      result: "5-hour limit reached · resets 3pm (UTC)",
      timezone: "America/Los_Angeles",
    });
    const expectedResetTime = new Date("2024-03-15T15:00:00+00:00");
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: expectedResetTime.getTime(),
    });
  });

  it("should parse 'Limit reached' generic message", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Limit reached",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse 'Limit reached · resets 3pm (UTC)' with UTC timezone", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Limit reached · resets 3pm (UTC) · /upgrade to Max 20x",
      timezone: "America/New_York",
    });
    const expectedResetTime = new Date("2024-03-15T15:00:00+00:00");
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: expectedResetTime.getTime(),
    });
  });

  it("should parse 'Usage limit reached' generic message", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Usage limit reached",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse 'Usage limit reached · resets 5pm (UTC)'", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Usage limit reached · resets 5pm (UTC) · turn on /extra-usage",
      timezone: "America/Los_Angeles",
    });
    const expectedResetTime = new Date("2024-03-15T17:00:00+00:00");
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: expectedResetTime.getTime(),
    });
  });

  it("should parse 'Weekly limit reached'", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Weekly limit reached",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse 'Weekly limit reached' with reset time", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Weekly limit reached ∙ resets 6pm",
      timezone: "America/New_York",
    });
    const expectedResetTime = new Date("2024-03-15T18:00:00-04:00");
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: true,
      rateLimitResetTime: expectedResetTime.getTime(),
    });
  });

  it("should parse 'Opus weekly limit reached'", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Opus weekly limit reached",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse 'Sonnet weekly limit reached'", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Sonnet weekly limit reached",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse 'Sonnet weekly limit reached · resets 3pm (UTC)'", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Sonnet weekly limit reached · resets 3pm (UTC) · /model opus",
      timezone: "America/New_York",
    });
    const expectedResetTime = new Date("2024-03-15T15:00:00+00:00");
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: expectedResetTime.getTime(),
    });
  });

  it("should parse 'Weekly limit reached · resets 4pm (UTC)' with UTC timezone", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Weekly limit reached · resets 4pm (UTC) · /upgrade to Max 20x",
      timezone: "America/Los_Angeles",
    });
    const expectedResetTime = new Date("2024-03-15T16:00:00+00:00");
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: expectedResetTime.getTime(),
    });
  });

  it("should parse 'Opus weekly limit reached · resets 5pm (UTC)'", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Opus weekly limit reached · resets 5pm (UTC) · contact an admin",
      timezone: "UTC",
    });
    const expectedResetTime = new Date("2024-03-15T17:00:00+00:00");
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: expectedResetTime.getTime(),
    });
  });

  it("should parse 'Weekly limit reached ∙ resets [time]' with day prefix (no time parsing)", async () => {
    // Note: Day prefix like "Mon 10am" isn't parsed for reset time
    const result = parseClaudeRateLimitMessageStr({
      result: "Weekly limit reached ∙ resets Mon 10am",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse 'Opus weekly limit reached ∙ resets [time]' with day prefix (no time parsing)", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Opus weekly limit reached ∙ resets Mon 10am",
      timezone: "America/New_York",
    });
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should handle normal result without rate limit", async () => {
    const result = parseClaudeRateLimitMessageStr({
      result: "Success",
      timezone: "America/New_York",
    });
    expect(result).toEqual(null);
  });
});

describe("parseCodexRateLimitMessage", () => {
  beforeEach(() => {
    // Fix the system time to a known date/time for predictable tests
    // March 15, 2024 at 10:00:00 AM EST (1710511200000 ms)
    const mockDate = new Date("2024-03-15T10:00:00-04:00");
    vi.useFakeTimers();
    vi.setSystemTime(mockDate);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should parse 'less than a minute' rate limit message", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in less than a minute.",
    );
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + 60 * 1000, // Current time + 1 minute
    });
  });

  it("should parse '5 minutes' rate limit message", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 5 minutes.",
    );
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + 5 * 60 * 1000, // Current time + 5 minutes
    });
  });

  it("should parse '1 minute' (singular) rate limit message", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 1 minute.",
    );
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + 1 * 60 * 1000, // Current time + 1 minute
    });
  });

  it("should parse '1 hour' (singular) rate limit message", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 1 hour.",
    );
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + 1 * 60 * 60 * 1000, // Current time + 1 hour
    });
  });

  it("should parse '3 hours 32 minutes' rate limit message", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 3 hours 32 minutes.",
    );
    const expectedDuration = (3 * 60 + 32) * 60 * 1000; // 12,720,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse '11 hours 46 minutes' rate limit message (production example)", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 11 hours 46 minutes.",
    );
    const expectedDuration = (11 * 60 + 46) * 60 * 1000; // 42,360,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse '2 days 3 hours 5 minutes' rate limit message", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 2 days 3 hours 5 minutes.",
    );
    const expectedDuration = (2 * 24 * 60 + 3 * 60 + 5) * 60 * 1000; // 183,900,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse '1 day 1 hour 1 minute' (all singular) rate limit message", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 1 day 1 hour 1 minute.",
    );
    const expectedDuration = (1 * 24 * 60 + 1 * 60 + 1) * 60 * 1000; // 90,060,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse messages with only hours", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 5 hours.",
    );
    const expectedDuration = 5 * 60 * 60 * 1000; // 18,000,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse messages with days and minutes (no hours)", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 2 days 15 minutes.",
    );
    const expectedDuration = (2 * 24 * 60 + 15) * 60 * 1000; // 172,500,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse messages with days and hours (no minutes)", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 1 day 5 hours.",
    );
    const expectedDuration = (1 * 24 * 60 + 5 * 60) * 60 * 1000; // 104,400,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should return null for non-Codex rate limit messages", () => {
    const result1 = parseCodexRateLimitMessageStr("Success");
    expect(result1).toEqual(null);

    const result2 = parseCodexRateLimitMessageStr(
      "Claude AI usage limit reached|1752350400",
    );
    expect(result2).toEqual(null);

    const result3 = parseCodexRateLimitMessageStr("Some other error message");
    expect(result3).toEqual(null);
  });

  it("should return null for empty string", () => {
    const result = parseCodexRateLimitMessageStr("");
    expect(result).toEqual(null);
  });

  it("should handle malformed duration strings gracefully", () => {
    // Missing period at end
    const result1 = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 5 minutes",
    );
    expect(result1).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + 5 * 60 * 1000,
    });

    // Correct prefix but invalid duration format
    const result2 = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in some time.",
    );
    expect(result2).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null, // Can't parse duration
    });
  });

  // Test cases for duration-based format
  it("should parse duration-based limit message with hours and minutes", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 3 hours 52 minutes.",
    );
    const expectedDuration = (3 * 60 + 52) * 60 * 1000; // 13,920,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse Plus plan format with just minutes", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 15 minutes.",
    );
    const expectedDuration = 15 * 60 * 1000;
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse Plus plan format with 'less than a minute'", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in less than a minute.",
    );
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + 60 * 1000,
    });
  });

  // Test cases for Team/Business plan format
  it("should parse Team/Business plan 'send a request to your admin or try again in' format", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. To get more access now, send a request to your admin or try again in 1 hour 46 minutes.",
    );
    const expectedDuration = (1 * 60 + 46) * 60 * 1000; // 6,360,000 ms
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse Team/Business plan format with just hours", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. To get more access now, send a request to your admin or try again in 2 hours.",
    );
    const expectedDuration = 2 * 60 * 60 * 1000;
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse Team/Business plan format with days, hours, and minutes", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. To get more access now, send a request to your admin or try again in 1 day 5 hours 30 minutes.",
    );
    const expectedDuration = (1 * 24 * 60 + 5 * 60 + 30) * 60 * 1000;
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  // Test cases for rate limits without retry time
  it("should parse rate limit format without retry time", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Please try again later.",
    );
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse Free plan format without trailing period", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Please try again later",
    );
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: null,
    });
  });

  it("should parse Plus plan format with days, hours, and minutes", () => {
    const result = parseCodexRateLimitMessageStr(
      "You've hit your usage limit. Try again in 4 days 19 hours 48 minutes.",
    );
    const expectedDuration = (4 * 24 * 60 + 19 * 60 + 48) * 60 * 1000;
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });

  it("should parse rate limit from error_during_execution subtype with error field", () => {
    const message = {
      type: "result" as const,
      subtype: "error_during_execution" as const,
      session_id: "",
      error:
        "You've hit your usage limit. Try again in 4 days 19 hours 48 minutes.",
      is_error: true as const,
      num_turns: 0,
      duration_ms: 0,
    };
    const result = parseCodexRateLimitMessage(message);
    const expectedDuration = (4 * 24 * 60 + 19 * 60 + 48) * 60 * 1000;
    expect(result).toEqual({
      isRateLimited: true,
      timezoneIsAmbiguous: false,
      rateLimitResetTime: 1710511200000 + expectedDuration,
    });
  });
});
