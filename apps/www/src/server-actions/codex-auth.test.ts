import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { saveCodexAuthJson as saveCodexAuthJsonAction } from "./codex-auth";
import { unwrapResult } from "@/lib/server-actions";
import { mockLoggedInUser } from "@/test-helpers/mock-next";
import { createTestUser } from "@terragon/shared/model/test-helpers";
import { getAgentProviderCredentialsDecrypted } from "@terragon/shared/model/agent-provider-credentials";
import { env } from "@terragon/env/apps-www";

const saveCodexAuthJson = async ({ authJson }: { authJson: string }) => {
  return unwrapResult(await saveCodexAuthJsonAction({ authJson }));
};

describe("saveCodexAuthJson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects auth.json without a refresh token", async () => {
    const testUser = await createTestUser({ db });
    await mockLoggedInUser(testUser.session);

    await expect(
      saveCodexAuthJson({
        authJson: JSON.stringify({
          tokens: {
            access_token: "access-token",
          },
        }),
      }),
    ).rejects.toThrow(
      "Invalid OpenAI credentials, please paste a fresh auth.json from 'codex login'",
    );
  });

  it("stores auth.json with access and refresh tokens", async () => {
    const testUser = await createTestUser({ db });
    await mockLoggedInUser(testUser.session);

    await saveCodexAuthJson({
      authJson: JSON.stringify({
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          account_id: "account-1",
        },
      }),
    });

    const credentials = await getAgentProviderCredentialsDecrypted({
      db,
      userId: testUser.user.id,
      agent: "codex",
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
    });
    expect(credentials?.accessToken).toBe("access-token");
    expect(credentials?.refreshToken).toBe("refresh-token");
  });
});
