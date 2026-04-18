import { env } from "@terragon/env/apps-www";
import * as schema from "@terragon/shared/db/schema";
import crypto from "crypto";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  refreshGitHubPrProjection,
  refreshGitHubRepoProjection,
} from "@/server-lib/github-projection-refresh";
import { createMockNextRequest } from "@/test-helpers/mock-next";
import { POST } from "./route";

vi.mock("@/server-lib/github-projection-refresh", async () => {
  const actual = await vi.importActual<
    typeof import("@/server-lib/github-projection-refresh")
  >("@/server-lib/github-projection-refresh");

  return {
    ...actual,
    refreshGitHubPrProjection: vi.fn(),
    refreshGitHubRepoProjection: vi.fn(),
  };
});

function createSignature(payload: string, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  return `sha256=${hmac.update(payload).digest("hex")}`;
}

async function createMockRequest(
  body: unknown,
  eventType: string,
  customHeaders: Record<string, string> = {},
): Promise<NextRequest> {
  const payload = JSON.stringify(body);
  const deliveryId = customHeaders["x-github-delivery"] ?? crypto.randomUUID();
  const signature =
    customHeaders["x-hub-signature-256"] ||
    createSignature(payload, env.GITHUB_WEBHOOK_SECRET);

  return createMockNextRequest(body, {
    "x-github-delivery": deliveryId,
    "x-hub-signature-256": signature,
    "x-github-event": eventType,
    ...customHeaders,
  });
}

describe("GitHub webhook route shadow refresh integration", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.delete(schema.githubPrProjection);
    await db.delete(schema.githubRepoProjection);
    await db.delete(schema.githubInstallationProjection);
    await db.delete(schema.githubWebhookDeliveries);
    vi.mocked(refreshGitHubRepoProjection).mockResolvedValue(
      undefined as never,
    );
    vi.mocked(refreshGitHubPrProjection).mockResolvedValue(undefined as never);
  });

  it("keeps the webhook response shape while persisting repo projection rows for issue webhooks", async () => {
    const repoFullName = "terragon/shadow-issues";
    const request = await createMockRequest(
      {
        action: "opened",
        issue: {
          number: 7,
          title: "Shadow refresh should populate repo projection",
        },
        repository: {
          full_name: repoFullName,
          owner: { login: "terragon", id: 42 },
          name: "shadow-issues",
        },
        sender: { login: "external-user" },
      },
      "issues",
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data).toMatchObject({
      success: true,
      claimOutcome: "claimed_new",
    });

    expect(refreshGitHubRepoProjection).toHaveBeenCalledTimes(1);
    expect(refreshGitHubRepoProjection).toHaveBeenCalledWith({
      repoFullName,
    });
  });

  it("keeps the webhook response shape while persisting PR projection rows for pull request webhooks", async () => {
    const repoFullName = "terragon/shadow-prs";
    const request = await createMockRequest(
      {
        action: "opened",
        pull_request: {
          number: 19,
          draft: false,
          merged: false,
          user: { login: "contributor", id: 777 },
          head: {
            ref: "feature/shadow-refresh",
            sha: "shadow-sha-123",
          },
          base: { ref: "main" },
        },
        repository: {
          full_name: repoFullName,
          owner: { login: "terragon", id: 42 },
          name: "shadow-prs",
        },
        sender: { login: "external-user" },
      },
      "pull_request",
    );

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(202);
    expect(data).toMatchObject({
      success: true,
      claimOutcome: "claimed_new",
    });

    expect(refreshGitHubPrProjection).toHaveBeenCalledTimes(1);
    expect(refreshGitHubPrProjection).toHaveBeenCalledWith({
      repoFullName,
      prNumber: 19,
    });
  });
});
