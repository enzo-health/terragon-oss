import { describe, expect, it } from "vitest";
import { resolvePublicAppUrl } from "../../../../packages/env/src/next-public";

describe("resolvePublicAppUrl", () => {
  it("uses the configured app URL when present", () => {
    expect(
      resolvePublicAppUrl({
        nodeEnv: "production",
        appUrl: "https://app.example",
      }),
    ).toBe("https://app.example");
  });

  it("falls back to the Vercel production project URL when app URL is absent", () => {
    expect(
      resolvePublicAppUrl({
        nodeEnv: "production",
        appUrl: null,
        vercelEnv: "production",
        vercelProductionHost: "terragon.vercel.app",
      }),
    ).toBe("https://terragon.vercel.app");
  });

  it("prefers the preview deployment URL when available", () => {
    expect(
      resolvePublicAppUrl({
        nodeEnv: "production",
        appUrl: null,
        vercelEnv: "preview",
        vercelPublicHost: "terragon-git-feature.vercel.app",
        vercelProductionHost: "terragon.vercel.app",
      }),
    ).toBe("https://terragon-git-feature.vercel.app");
  });
});
