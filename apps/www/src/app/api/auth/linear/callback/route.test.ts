import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const linearClient = {
    organization: Promise.resolve({ id: "org_123", name: "Acme Linear" }),
    viewer: Promise.resolve({ id: "app_user_123" }),
  };

  return {
    db: { label: "mock-db" },
    getUserIdOrNull: vi.fn(async (): Promise<string | null> => "user_123"),
    upsertLinearInstallation: vi.fn(async (): Promise<void> => undefined),
    upsertLinearAccount: vi.fn(async (): Promise<void> => undefined),
    encryptValue: vi.fn((value: string): string => `encrypted:${value}`),
    decryptValue: vi.fn((): string =>
      JSON.stringify({
        userId: "user_123",
        timestamp: Date.now(),
        type: "agent_install",
      }),
    ),
    nonLocalhostPublicAppUrl: vi.fn((): string => "https://app.terragon.test"),
    linearClient,
    LinearClient: vi.fn(() => linearClient),
    redirect: vi.fn((url: string): never => {
      throw new Error(url);
    }),
    notFound: vi.fn((): never => {
      throw new Error("NOT_FOUND");
    }),
  };
});

vi.mock("@/lib/auth-server", () => ({
  getUserIdOrNull: mocks.getUserIdOrNull,
}));

vi.mock("@/lib/db", () => ({
  db: mocks.db,
}));

vi.mock("@terragon/shared/model/linear", () => ({
  upsertLinearAccount: mocks.upsertLinearAccount,
  upsertLinearInstallation: mocks.upsertLinearInstallation,
}));

vi.mock("@terragon/utils/encryption", () => ({
  decryptValue: mocks.decryptValue,
  encryptValue: mocks.encryptValue,
}));

vi.mock("@terragon/env/apps-www", () => ({
  env: {
    ENCRYPTION_MASTER_KEY: "test-key",
    LINEAR_CLIENT_ID: "linear-client-id",
    LINEAR_CLIENT_SECRET: "linear-client-secret",
  },
}));

vi.mock("@/lib/server-utils", () => ({
  nonLocalhostPublicAppUrl: mocks.nonLocalhostPublicAppUrl,
}));

vi.mock("@linear/sdk", () => ({
  LinearClient: mocks.LinearClient,
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect,
}));

import { GET } from "./route";

describe("Linear OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.linearClient.organization = Promise.resolve({
      id: "org_123",
      name: "Acme Linear",
    });
    mocks.linearClient.viewer = Promise.resolve({ id: "app_user_123" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (): Promise<Response> => {
        return Response.json({
          access_token: "linear-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read,write,app:assignable,app:mentionable",
          refresh_token: "linear-refresh-token",
        });
      }),
    );
  });

  it("persists the Linear app viewer id during agent install", async () => {
    const request = new NextRequest(
      "https://app.terragon.test/api/auth/linear/callback?code=oauth-code&state=encrypted-state",
    );

    await expect(GET(request)).rejects.toThrow(
      "/settings/integrations?integration=linear&status=success&code=agent_installed",
    );

    expect(mocks.LinearClient).toHaveBeenCalledWith({
      accessToken: "linear-access-token",
    });
    expect(mocks.upsertLinearInstallation).toHaveBeenCalledWith({
      db: mocks.db,
      installation: expect.objectContaining({
        organizationId: "org_123",
        organizationName: "Acme Linear",
        appUserId: "app_user_123",
        accessTokenEncrypted: "encrypted:linear-access-token",
        refreshTokenEncrypted: "encrypted:linear-refresh-token",
        scope: "read,write,app:assignable,app:mentionable",
        installerUserId: "user_123",
        isActive: true,
      }),
    });
    expect(mocks.upsertLinearAccount).not.toHaveBeenCalled();
  });
});
