import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestUser } from "./test-helpers";
import { createDb } from "../db";
import {
  insertAgentProviderCredentials,
  getAgentProviderCredentialsDecrypted,
  getAgentProviderCredentialsRecord,
  deleteAgentProviderCredentialById,
  getAllAgentProviderCredentialRecords,
  getValidAccessTokenForCredential,
} from "./agent-provider-credentials";

const db = createDb(process.env.DATABASE_URL!);

const CLAUDE_CODE_API_KEY_CREDENTIALS = {
  agent: "claudeCode",
  type: "api-key",
  apiKey: "test-claude-code-api-key",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastRefreshedAt: null,
  expiresAt: null,
  metadata: null,
  isActive: true,
} as const;

const CLAUDE_CODE_OAUTH_CREDENTIALS = {
  agent: "claudeCode",
  type: "oauth",
  accessToken: "test-access-token",
  refreshToken: "test-refresh-token",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastRefreshedAt: null,
  expiresAt: null,
  metadata: null,
  isActive: true,
} as const;

const CODEX_API_KEY_CREDENTIALS = {
  agent: "codex",
  type: "api-key",
  apiKey: "test-codex-api-key",
  createdAt: new Date(),
  updatedAt: new Date(),
  lastRefreshedAt: null,
  expiresAt: null,
  metadata: null,
  isActive: true,
} as const;

describe("agent-provider-credentials", () => {
  let userId: string;
  const encryptionKey = "test-encryption-key-32-chars-long";

  beforeEach(async () => {
    const testUser = await createTestUser({ db });
    userId = testUser.user.id;
  });

  describe("insertAgentProviderCredentials", () => {
    it("should store API key credentials", async () => {
      const result = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      expect(result).toBeDefined();
      expect(result.userId).toBe(userId);
      expect(result.agent).toBe("claudeCode");
      expect(result.type).toBe("api-key");
      expect(result.apiKeyEncrypted).toBeDefined();
      expect(result.accessTokenEncrypted).toBeNull();
    });

    it("should store OAuth credentials", async () => {
      const result = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_OAUTH_CREDENTIALS,
        encryptionKey,
      });

      expect(result).toBeDefined();
      expect(result.agent).toBe("claudeCode");
      expect(result.type).toBe("oauth");
      expect(result.accessTokenEncrypted).toBeDefined();
      expect(result.refreshTokenEncrypted).toBeDefined();
    });
  });

  describe("getAgentProviderCredentialsDecrypted", () => {
    it("should retrieve and decrypt credentials", async () => {
      await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      const result = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        agent: "claudeCode",
        encryptionKey,
      });
      expect(result).toBeDefined();
      expect(result!.agent).toBe("claudeCode");
      expect(result!.type).toBe("api-key");
      expect(result!.apiKey).toBe(CLAUDE_CODE_API_KEY_CREDENTIALS.apiKey);
    });

    it("should return null for non-existent credentials", async () => {
      const result = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        agent: "claudeCode",
        encryptionKey,
      });
      expect(result).toBeNull();
    });
  });

  describe("getAllAgentProviderCredentialsDecrypted", () => {
    it("should retrieve all credentials for a user", async () => {
      await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });

      await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CODEX_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      const result = await getAllAgentProviderCredentialRecords({
        db,
        userId,
      });
      expect(result).toHaveLength(2);
      expect(result.find((c) => c.agent === "claudeCode")).toBeDefined();
      expect(result.find((c) => c.agent === "codex")).toBeDefined();
    });
  });

  describe("deleteAgentProviderCredentials", () => {
    it("should delete credentials", async () => {
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      await deleteAgentProviderCredentialById({
        db,
        userId,
        credentialId: credential.id,
      });
      const record = await getAgentProviderCredentialsRecord({
        db,
        userId,
        agent: "claudeCode",
      });
      expect(record).toBeUndefined();
    });
  });

  describe("getValidAccessTokenForCredential", () => {
    it("should return null when credentials exist but no access token", async () => {
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: CLAUDE_CODE_API_KEY_CREDENTIALS,
        encryptionKey,
      });
      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
      });
      expect(result).toBeNull();
    });

    it("should return access token when valid and not expired", async () => {
      const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: futureDate,
        },
        encryptionKey,
      });
      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
      });
      expect(result).toBe("test-access-token");
    });

    it("should return access token if no expiration date", async () => {
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: null,
        },
        encryptionKey,
      });
      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
      });
      expect(result).toBe("test-access-token");
    });

    it("should refresh token if expired and callback provided", async () => {
      const pastDate = new Date(Date.now() - 1000); // 1 second ago
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: pastDate,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(),
        metadata: null,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      expect(refreshTokenCallback).toHaveBeenCalledWith({
        refreshToken: "test-refresh-token",
      });
      expect(result).toBe("new-access-token");
    });

    it("should update only changed fields during token refresh", async () => {
      const pastDate = new Date(Date.now() - 1000);
      const originalMetadata = { type: "claude" as const };
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: pastDate,
          metadata: originalMetadata,
        },
        encryptionKey,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
      });

      expect(result).toBe("test-access-token");
    });

    it("should return expired token when no refresh token available", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          refreshToken: undefined,
          expiresAt: pastDate,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn();

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      expect(result).toBe("test-access-token");
      expect(refreshTokenCallback).not.toHaveBeenCalled();
    });

    it("should not return the stored access token when force refresh cannot refresh", async () => {
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          refreshToken: undefined,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn();

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        forceRefresh: true,
        refreshTokenCallback,
      });

      expect(result).toBeNull();
      expect(refreshTokenCallback).not.toHaveBeenCalled();
    });

    it("should force refresh even when the credential has no expiration date", async () => {
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: null,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: "forced-access-token",
        refreshToken: "forced-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        metadata: null,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        forceRefresh: true,
        refreshTokenCallback,
      });

      expect(result).toBe("forced-access-token");
      expect(refreshTokenCallback).toHaveBeenCalledWith({
        refreshToken: "test-refresh-token",
      });
    });

    it("should use 1 hour buffer before expiration", async () => {
      // Token expires in 30 minutes (within the 1-hour buffer)
      const nearFutureDate = new Date(Date.now() + 30 * 60 * 1000);
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: nearFutureDate,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: "refreshed-access-token",
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(),
        metadata: null,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      expect(result).toBe("refreshed-access-token");
      expect(refreshTokenCallback).toHaveBeenCalled();
    });

    it("should preserve existing metadata when refreshing", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: pastDate,
          metadata: { type: "claude", accountEmail: "test@example.com" },
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(),
        metadata: { type: "claude", accountId: "1234567890" },
      });

      await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      const updatedCreds = await getAgentProviderCredentialsDecrypted({
        db,
        userId,
        agent: "claudeCode",
        encryptionKey,
      });
      expect(updatedCreds!.metadata).toEqual({
        type: "claude",
        accountEmail: "test@example.com",
        accountId: "1234567890",
      });
    });

    it("should handle refresh callback returning null accessToken", async () => {
      const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const credential = await insertAgentProviderCredentials({
        db,
        userId,
        credentialData: {
          ...CLAUDE_CODE_OAUTH_CREDENTIALS,
          expiresAt: pastDate,
        },
        encryptionKey,
      });

      const refreshTokenCallback = vi.fn().mockResolvedValue({
        accessToken: null,
        refreshToken: "test-refresh-token",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastRefreshedAt: new Date(),
        metadata: null,
      });

      const result = await getValidAccessTokenForCredential({
        db,
        userId,
        credentialId: credential.id,
        encryptionKey,
        refreshTokenCallback,
      });

      expect(result).toBeNull();
    });
  });
});
