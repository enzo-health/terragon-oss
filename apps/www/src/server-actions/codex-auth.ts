"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { insertAgentProviderCredentials } from "@terragon/shared/model/agent-provider-credentials";
import { UserFacingError } from "@/lib/server-actions";
import { getPostHogServer } from "@/lib/posthog-server";

type OpenAIAuthJson = {
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
};

function parseOpenAiIdToken(idToken: string): {
  exp?: number;
  email?: string;
  chatgptAccountId?: string;
} {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      return {};
    }
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf-8"),
    ) as {
      exp?: number;
      email?: string;
      "https://api.openai.com/auth.chatgpt_account_id"?: string;
    };
    return {
      exp: payload.exp,
      email: payload.email,
      chatgptAccountId:
        payload["https://api.openai.com/auth.chatgpt_account_id"],
    };
  } catch (error) {
    console.warn("Failed to parse OpenAI id_token", error);
    return {};
  }
}

export const saveCodexAuthJson = userOnlyAction(
  async function saveCodexAuthJson(
    userId: string,
    { authJson }: { authJson: string },
  ) {
    const parsed = JSON.parse(authJson || "{}") as OpenAIAuthJson;
    const tokens = parsed.tokens;
    const idToken = tokens?.id_token;
    const accessToken = tokens?.access_token;
    const refreshToken = tokens?.refresh_token;
    const accountId = tokens?.account_id;

    if (!accessToken) {
      throw new UserFacingError(
        "Invalid OpenAI credentials, please paste a fresh auth.json from 'codex login'",
      );
    }
    const idTokenPayload = idToken ? parseOpenAiIdToken(idToken) : {};
    const expiresAt = idTokenPayload.exp
      ? new Date(idTokenPayload.exp * 1000)
      : null;

    getPostHogServer().capture({
      distinctId: userId,
      event: "codex_oauth_tokens_saved",
      properties: {},
    });
    await insertAgentProviderCredentials({
      db,
      userId,
      credentialData: {
        type: "oauth",
        agent: "codex",
        isActive: true,
        accessToken,
        refreshToken,
        idToken,
        expiresAt,
        lastRefreshedAt: new Date(),
        metadata: {
          type: "openai",
          accountId: accountId ?? idTokenPayload.chatgptAccountId,
          email: idTokenPayload.email,
        },
      },
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
    });
  },
  { defaultErrorMessage: "Failed to save Codex auth.json" },
);
