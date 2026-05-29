import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import {
  getAgentProviderCredentialsDecrypted,
  getAgentProviderCredentialsDecryptedById,
  getValidAccessTokenForCredential,
} from "@terragon/shared/model/agent-provider-credentials";
import { refreshAccessToken } from "@/lib/openai-oauth";
import { retryAsync } from "@terragon/utils/retry";

type CodexAuthJson = {
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string | null;
  };
  last_refresh: string;
};

type CodexChatGptAuthTokens = {
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType?: string;
};

function parseOpenAIIdTokenMetadata(idToken: string): {
  chatgptAccountId?: string;
  planType?: string;
} {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      return {};
    }
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf-8"),
    ) as {
      "https://api.openai.com/auth.chatgpt_account_id"?: unknown;
      "https://api.openai.com/auth.chatgpt_plan_type"?: unknown;
    };
    const chatgptAccountId =
      payload["https://api.openai.com/auth.chatgpt_account_id"];
    const planType = payload["https://api.openai.com/auth.chatgpt_plan_type"];
    return {
      chatgptAccountId:
        typeof chatgptAccountId === "string" ? chatgptAccountId : undefined,
      planType: typeof planType === "string" ? planType : undefined,
    };
  } catch {
    return {};
  }
}

async function getValidAccessTokenInternal({
  userId,
  credentialId,
  forceRefresh = false,
}: {
  userId: string;
  credentialId: string;
  forceRefresh?: boolean;
}): Promise<string | null> {
  return await getValidAccessTokenForCredential({
    db,
    userId,
    credentialId,
    encryptionKey: env.ENCRYPTION_MASTER_KEY,
    forceRefresh,
    refreshTokenCallback: async (tokenDataToRefresh) => {
      const response = await refreshAccessToken(
        tokenDataToRefresh.refreshToken,
      );
      return {
        accessToken: response.access_token,
        expiresAt: response.expires_in
          ? new Date(Date.now() + response.expires_in * 1000)
          : null,
        refreshToken: response.refresh_token,
        idToken: response.id_token,
        lastRefreshedAt: new Date(),
        metadata: null,
      };
    },
  });
}

/**
 * Wraps getValidAccessTokenInternal with retry to handle the case where
 * multiple processes refresh the token at the same time.
 */
async function getValidAccessToken({
  userId,
  credentialId,
  forceRefresh = false,
}: {
  userId: string;
  credentialId: string;
  forceRefresh?: boolean;
}): Promise<string | null> {
  return retryAsync(
    () => {
      return getValidAccessTokenInternal({
        userId,
        credentialId,
        forceRefresh,
      });
    },
    { label: "getValidAccessToken (codex)" },
  );
}

/**
 * Force refresh of Codex credentials (for admin use)
 */
export async function forceRefreshCodexCredentials({
  userId,
  credentialId,
}: {
  userId: string;
  credentialId: string;
}): Promise<string | null> {
  return getValidAccessToken({ userId, credentialId, forceRefresh: true });
}

export async function refreshCodexChatGptAuthTokens({
  userId,
  credentialId,
}: {
  userId: string;
  credentialId: string;
}): Promise<CodexChatGptAuthTokens | null> {
  const credentials = await getAgentProviderCredentialsDecryptedById({
    db,
    userId,
    credentialId,
    encryptionKey: env.ENCRYPTION_MASTER_KEY,
  });
  if (!credentials?.accessToken || credentials.type !== "oauth") {
    return null;
  }
  if (credentials.agent !== "codex") {
    return null;
  }

  const accessToken = await getValidAccessToken({
    userId,
    credentialId: credentials.id,
    forceRefresh: true,
  });
  if (!accessToken) {
    return null;
  }

  const reloaded = await getAgentProviderCredentialsDecryptedById({
    db,
    userId,
    credentialId: credentials.id,
    encryptionKey: env.ENCRYPTION_MASTER_KEY,
  });
  const finalCredentials = reloaded?.accessToken ? reloaded : credentials;
  const metadata =
    finalCredentials.metadata?.type === "openai"
      ? finalCredentials.metadata
      : null;
  const idTokenMetadata = finalCredentials.idToken
    ? parseOpenAIIdTokenMetadata(finalCredentials.idToken)
    : {};
  const chatgptAccountId =
    idTokenMetadata.chatgptAccountId ??
    metadata?.chatgptAccountId ??
    metadata?.accountId;
  if (!chatgptAccountId) {
    return null;
  }

  const chatgptPlanType = idTokenMetadata.planType ?? metadata?.planType;
  return {
    accessToken,
    chatgptAccountId,
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
  };
}

export async function getActiveCodexOAuthCredentialId({
  userId,
}: {
  userId: string;
}): Promise<string | null> {
  const credentials = await getAgentProviderCredentialsDecrypted({
    db,
    userId,
    agent: "codex",
    encryptionKey: env.ENCRYPTION_MASTER_KEY,
  });
  if (credentials?.type !== "oauth" || !credentials.accessToken) {
    return null;
  }
  return credentials.id;
}

/**
 * Get Codex (OpenAI) credentials in the format of ~/.codex/auth.json
 * Returns null if no valid credentials exist.
 */
export async function getCodexCredentialsJSONOrNull({
  userId,
}: {
  userId: string;
}): Promise<{
  contents: string | null;
  error: string | null;
}> {
  try {
    const credentials = await getAgentProviderCredentialsDecrypted({
      db,
      userId,
      agent: "codex",
      encryptionKey: env.ENCRYPTION_MASTER_KEY,
    });
    if (credentials?.apiKey) {
      return {
        contents: JSON.stringify({
          apiKey: credentials.apiKey,
        }),
        error: null,
      };
    }
    if (!credentials?.accessToken) {
      return { contents: null, error: null };
    }
    // Codex app-server reads auth.json as managed ChatGPT auth and may refresh
    // locally. Terragon owns the refresh token, so every sandbox auth file must
    // start from a server-refreshed access token.
    const validAccessToken = await getValidAccessToken({
      userId,
      credentialId: credentials.id,
      forceRefresh: true,
    });
    if (!validAccessToken) {
      return {
        contents: null,
        error:
          "OpenAI account session expired. Reconnect your ChatGPT account in settings.",
      };
    }
    // Reload auth data if token was refreshed
    let finalCredentials = {
      ...credentials,
      accessToken: validAccessToken,
    };
    if (validAccessToken && validAccessToken !== credentials.accessToken) {
      const reloaded = await getAgentProviderCredentialsDecryptedById({
        db,
        userId,
        credentialId: credentials.id,
        encryptionKey: env.ENCRYPTION_MASTER_KEY,
      });
      if (reloaded?.accessToken) {
        finalCredentials = {
          ...reloaded,
          accessToken: reloaded.accessToken,
        };
      }
    }

    if (!finalCredentials?.accessToken) {
      return { contents: null, error: null };
    }
    const authJson: CodexAuthJson = {
      tokens: {
        id_token: finalCredentials.idToken || "",
        access_token: finalCredentials.accessToken,
        refresh_token: "", // We don't want the cli to refresh the token
        account_id: finalCredentials.metadata?.accountId || null,
      },
      // Always tell codex that we just refreshed the token so it doesn't try to.
      last_refresh: new Date().toISOString(),
    };
    return { contents: JSON.stringify(authJson), error: null };
  } catch (error) {
    console.error("[getCodexCredentialsJSONOrNull] Failed:", error);
    if (
      error instanceof Error &&
      error.message.includes("refresh_token_reused")
    ) {
      return {
        contents: null,
        error:
          "OpenAI account session expired. Reconnect your ChatGPT account in settings.",
      };
    }
    return { contents: null, error: "Failed to get Codex credentials" };
  }
}
