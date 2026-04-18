import { env } from "@terragon/env/apps-www";
import * as schema from "@terragon/shared/db/schema";
import { getGitHubApp } from "@terragon/shared/github-app";
import {
  getGithubPrProjectionByPrNodeId,
  getGithubRepoProjectionByRepoId,
} from "@terragon/shared/model/github-projections";
import crypto from "crypto";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { getOctokitForApp } from "@/lib/github";
import { createMockNextRequest } from "@/test-helpers/mock-next";
import { POST } from "./route";

vi.mock("@terragon/shared/github-app", () => ({
  getGitHubApp: vi.fn(),
  getInstallationToken: vi.fn().mockResolvedValue("mock-github-token"),
  getSandboxGithubToken: vi.fn().mockResolvedValue("mock-github-token"),
}));

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

    vi.mocked(getGitHubApp).mockReturnValue({
      octokit: {
        request: vi.fn(
          async (route: string, params: Record<string, unknown>) => {
            switch (route) {
              case "GET /repos/{owner}/{repo}/installation":
                return {
                  data: {
                    id: 91001,
                  },
                };
              case "GET /app/installations/{installation_id}":
                return {
                  data: {
                    id: params.installation_id,
                    account: {
                      id: 42,
                      login: "terragon",
                      type: "Organization",
                    },
                    permissions: {
                      contents: "write",
                      pull_requests: "write",
                    },
                    suspended_at: null,
                  },
                };
              default:
                throw new Error(`Unhandled app request route: ${route}`);
            }
          },
        ),
      },
    } as unknown as ReturnType<typeof getGitHubApp>);

    vi.mocked(getOctokitForApp).mockResolvedValue({
      rest: {
        repos: {
          get: vi.fn(
            async ({ owner, repo }: { owner: string; repo: string }) => ({
              data: {
                id: 42001,
                node_id: "R_kgDOShadowRepo",
                full_name: `${owner}/${repo}`,
                default_branch: "main",
                private: true,
              },
            }),
          ),
        },
        pulls: {
          get: vi.fn(async ({ pull_number }: { pull_number: number }) => ({
            data: {
              node_id: "PR_kwDOShadowPr",
              number: pull_number,
              draft: false,
              closed_at: null,
              merged_at: null,
              base: { ref: "main" },
              head: {
                ref: "feature/shadow-refresh",
                sha: "shadow-sha-123",
              },
            },
          })),
        },
      },
    } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);
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

    const repoProjection = await getGithubRepoProjectionByRepoId({
      db,
      repoId: 42001,
    });

    expect(repoProjection).toBeTruthy();
    expect(repoProjection?.currentSlug).toBe(repoFullName);
    expect(repoProjection?.defaultBranch).toBe("main");
    expect(repoProjection?.hasWriteAccess).toBe(true);
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

    const prProjection = await getGithubPrProjectionByPrNodeId({
      db,
      prNodeId: "PR_kwDOShadowPr",
    });

    expect(prProjection).toBeTruthy();
    expect(prProjection?.repoId).toBe(42001);
    expect(prProjection?.number).toBe(19);
    expect(prProjection?.headSha).toBe("shadow-sha-123");
    expect(prProjection?.status).toBe("open");
  });
});
