import { describe, expect, it } from "vitest";
import {
  RUNTIME_FAILURE_ACTION_TABLE,
  mapDaemonTerminalCategoryToRuntimeFailureCategory,
} from "./failure";

describe("mapDaemonTerminalCategoryToRuntimeFailureCategory", () => {
  it("classifies a Codex usage-limit message as a non-retryable usage_limit", () => {
    const category = mapDaemonTerminalCategoryToRuntimeFailureCategory(
      "daemon_result_error",
      "You've hit your usage limit. To get more access now, send a request to your admin or try again at May 30th, 2026 10:36 PM.",
    );
    expect(category).toBe("usage_limit");
    expect(RUNTIME_FAILURE_ACTION_TABLE[category]).toBe("blocked");
  });

  it("classifies a Claude usage-limit message as usage_limit", () => {
    const category = mapDaemonTerminalCategoryToRuntimeFailureCategory(
      "daemon_custom_error",
      "Claude AI usage limit reached|1752350400",
    );
    expect(category).toBe("usage_limit");
  });

  it("still classifies context-window exhaustion as config_error", () => {
    const category = mapDaemonTerminalCategoryToRuntimeFailureCategory(
      "daemon_result_error",
      "context length exceeded",
    );
    expect(category).toBe("config_error");
  });

  it("leaves a generic runtime error as claude_runtime_exit (retryable)", () => {
    const category = mapDaemonTerminalCategoryToRuntimeFailureCategory(
      "daemon_result_error",
      "Codex error: something blew up",
    );
    expect(category).toBe("claude_runtime_exit");
    expect(RUNTIME_FAILURE_ACTION_TABLE[category]).toBe("retry_if_budget");
  });
});
