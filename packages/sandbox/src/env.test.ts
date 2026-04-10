import { describe, it, expect } from "vitest";
import { getEnv } from "./env";

describe("getEnv", () => {
  it("should set GH_TOKEN from githubAccessToken by default", () => {
    const env = getEnv({
      githubAccessToken: "default-token",
      userEnv: [],
      agentCredentials: null,
    });

    expect(env.GH_TOKEN).toBe("default-token");
  });

  it("should allow user-defined GH_TOKEN to override default", () => {
    const env = getEnv({
      githubAccessToken: "default-token",
      userEnv: [{ key: "GH_TOKEN", value: "custom-token" }],
      agentCredentials: null,
    });

    expect(env.GH_TOKEN).toBe("custom-token");
  });

  it("should set LEO to true", () => {
    const env = getEnv({
      githubAccessToken: "token",
      userEnv: [],
      agentCredentials: null,
    });

    expect(env.LEO).toBe("true");
  });

  it("should include user environment variables", () => {
    const env = getEnv({
      githubAccessToken: "token",
      userEnv: [
        { key: "API_KEY", value: "secret" },
        { key: "DATABASE_URL", value: "postgres://..." },
      ],
      agentCredentials: null,
    });

    expect(env.API_KEY).toBe("secret");
    expect(env.DATABASE_URL).toBe("postgres://...");
  });

  it("should include agent credentials as environment variable", () => {
    const env = getEnv({
      githubAccessToken: "token",
      userEnv: [],
      agentCredentials: {
        type: "env-var",
        key: "ANTHROPIC_API_KEY",
        value: "sk-ant-...",
      },
    });

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-...");
  });

  it("should apply overrides last", () => {
    const env = getEnv({
      githubAccessToken: "token",
      userEnv: [{ key: "TEST_VAR", value: "user-value" }],
      agentCredentials: null,
      overrides: { TEST_VAR: "override-value" },
    });

    expect(env.TEST_VAR).toBe("override-value");
  });

  it("should allow overrides to override GH_TOKEN", () => {
    const env = getEnv({
      githubAccessToken: "default-token",
      userEnv: [{ key: "GH_TOKEN", value: "user-token" }],
      agentCredentials: null,
      overrides: { GH_TOKEN: "override-token" },
    });

    expect(env.GH_TOKEN).toBe("override-token");
  });
});
