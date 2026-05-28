import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { insertAgentProviderCredentials } from "@terragon/shared/model/agent-provider-credentials";
import { getCodexCredentialsJSONOrNull } from "./codexCredentials";

vi.mock("@terragon/shared/broadcast-server", () => ({
  publishBroadcastUserMessage: vi.fn(),
}));

describe("getCodexCredentialsJSONOrNull", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("force-refreshes OAuth credentials before writing sandbox auth.json", async () => {
    const testUser = await createTestUser({ db });
    await insertAgentProviderCredentials({
      db,
      userId: testUser.user.id,
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
      credentialData: {
        agent: "codex",
        type: "oauth",
        isActive: true,
        accessToken: "old-access-token",
        refreshToken: "refresh-token",
        idToken: "old-id-token",
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        lastRefreshedAt: null,
        metadata: { type: "openai", accountId: "account-1" },
      },
    });
    const fetchMock = vi.mocked(fetch).mockResolvedValue(
      Response.json({
        access_token: "new-access-token",
        token_type: "Bearer",
        refresh_token: "new-refresh-token",
        id_token: "new-id-token",
        expires_in: 3600,
      }),
    );

    const result = await getCodexCredentialsJSONOrNull({
      userId: testUser.user.id,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"refresh_token":"refresh-token"'),
      }),
    );
    expect(result.error).toBeNull();
    expect(result.contents).not.toBeNull();

    const authJson = JSON.parse(result.contents ?? "{}") as {
      tokens?: {
        access_token?: string;
        refresh_token?: string;
      };
    };
    expect(authJson.tokens?.access_token).toBe("new-access-token");
    expect(authJson.tokens?.refresh_token).toBe("");
  });

  it("does not serialize the stored access token when force refresh fails", async () => {
    const testUser = await createTestUser({ db });
    await insertAgentProviderCredentials({
      db,
      userId: testUser.user.id,
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
      credentialData: {
        agent: "codex",
        type: "oauth",
        isActive: true,
        accessToken: "old-access-token",
        refreshToken: undefined,
        idToken: "old-id-token",
        expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        lastRefreshedAt: null,
        metadata: { type: "openai", accountId: "account-1" },
      },
    });

    const result = await getCodexCredentialsJSONOrNull({
      userId: testUser.user.id,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.contents).toBeNull();
    expect(result.error).toBe(
      "OpenAI account session expired. Reconnect your ChatGPT account in settings.",
    );
  });
});
