import { describe, expect, it } from "vitest";
import {
  getClientIpFromRequest,
  mintPreviewExchangeToken,
  verifyAndConsumePreviewExchangeToken,
} from "./preview-auth";

describe("getClientIpFromRequest", () => {
  it("prefers x-vercel-ip", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-vercel-ip": "203.0.113.7",
        "x-forwarded-for": "198.51.100.2",
      },
    });

    const result = getClientIpFromRequest(request);
    expect(result).toEqual({
      ip: "203.0.113.7",
      source: "x-vercel-ip",
    });
  });

  it("falls back to first forwarded IP", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "198.51.100.2, 10.0.0.5",
      },
    });

    const result = getClientIpFromRequest(request);
    expect(result).toEqual({
      ip: "198.51.100.2",
      source: "x-forwarded-for",
    });
  });
});

describe("verifyAndConsumePreviewExchangeToken", () => {
  it("allows single-use exchange tokens", async () => {
    const previewSessionId = crypto.randomUUID();
    const token = await mintPreviewExchangeToken({
      claims: {
        previewSessionId,
        threadId: crypto.randomUUID(),
        threadChatId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        userId: crypto.randomUUID(),
        codesandboxId: crypto.randomUUID(),
        sandboxProvider: "daytona",
      },
      nonce: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });

    const claims = await verifyAndConsumePreviewExchangeToken({
      token,
      expectedPreviewSessionId: previewSessionId,
    });

    expect(claims.previewSessionId).toBe(previewSessionId);

    await expect(
      verifyAndConsumePreviewExchangeToken({
        token,
        expectedPreviewSessionId: previewSessionId,
      }),
    ).rejects.toThrow();
  });
});
