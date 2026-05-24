import { describe, expect, it } from "vitest";
import { isDevLoginEnabled, resolveDevLoginReturnUrl } from "./auth";

describe("dev login helpers", () => {
  it("enables dev login in development when the explicit flag is set", () => {
    expect(isDevLoginEnabled({ nodeEnv: "development", enabled: true })).toBe(
      true,
    );
    expect(isDevLoginEnabled({ nodeEnv: "development", enabled: false })).toBe(
      false,
    );
    expect(isDevLoginEnabled({ nodeEnv: "production", enabled: true })).toBe(
      false,
    );
  });

  it("allows production-mode local benchmark runs only with the escape hatch", () => {
    const previous = process.env.TERRAGON_ALLOW_DEV_LOGIN_OUTSIDE_DEVELOPMENT;
    process.env.TERRAGON_ALLOW_DEV_LOGIN_OUTSIDE_DEVELOPMENT = "true";
    try {
      expect(isDevLoginEnabled({ nodeEnv: "production", enabled: true })).toBe(
        true,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TERRAGON_ALLOW_DEV_LOGIN_OUTSIDE_DEVELOPMENT;
      } else {
        process.env.TERRAGON_ALLOW_DEV_LOGIN_OUTSIDE_DEVELOPMENT = previous;
      }
    }
  });

  it("keeps dev login redirects on local paths", () => {
    expect(resolveDevLoginReturnUrl("/dashboard?tab=tasks")).toBe(
      "/dashboard?tab=tasks",
    );
    expect(resolveDevLoginReturnUrl("https://example.com")).toBe("/dashboard");
    expect(resolveDevLoginReturnUrl("//example.com")).toBe("/dashboard");
    expect(resolveDevLoginReturnUrl(undefined)).toBe("/dashboard");
  });
});
