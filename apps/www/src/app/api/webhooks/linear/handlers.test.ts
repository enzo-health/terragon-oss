import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { handleAgentSessionEvent, handleAppUserNotification } from "./handlers";
import { User } from "@terragon/shared";
import {
  createTestUser,
  setFeatureFlagOverrideForTest,
} from "@terragon/shared/model/test-helpers";
import {
  upsertLinearAccount,
  upsertLinearInstallation,
  upsertLinearSettings,
} from "@terragon/shared/model/linear";
import { db } from "@/lib/db";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import type { LinearClientFactory } from "@/server-lib/linear-agent-activity";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";

// Mock newThreadInternal
vi.mock("@/server-lib/new-thread-internal", () => ({
  newThreadInternal: vi.fn().mockResolvedValue({
    threadId: "test-thread-id",
    threadChatId: "test-chat-id",
  }),
}));

// Mock queueFollowUpInternal
vi.mock("@/server-lib/follow-up", () => ({
  queueFollowUpInternal: vi.fn().mockResolvedValue(undefined),
}));

// Mock waitUntil — using mockWaitUntil so we can await waitUntilResolved()
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

// Mock refreshLinearTokenIfNeeded
vi.mock("@/server-lib/linear-oauth", () => ({
  refreshLinearTokenIfNeeded: vi.fn().mockResolvedValue({
    status: "ok",
    accessToken: "test-access-token",
  }),
}));

// Mock Linear SDK
const mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
const mockUpdateAgentSession = vi.fn().mockResolvedValue({ success: true });
const mockIssueRepositorySuggestions = vi.fn().mockResolvedValue({
  suggestions: [
    {
      repositoryFullName: "owner/repo",
      hostname: "github.com",
      confidence: 0.9,
    },
  ],
});

const mockLinearClientInstance = {
  createAgentActivity: mockCreateAgentActivity,
  updateAgentSession: mockUpdateAgentSession,
  issueRepositorySuggestions: mockIssueRepositorySuggestions,
};

vi.mock("@linear/sdk", () => ({
  LinearClient: vi.fn().mockImplementation(() => mockLinearClientInstance),
}));

// ---------------------------------------------------------------------------
// Test injectable LinearClient factory
// ---------------------------------------------------------------------------

/** Factory that returns our mock client (bypasses the LinearClient constructor mock) */
const mockClientFactory: LinearClientFactory = (_token: string) =>
  mockLinearClientInstance as unknown as import("@linear/sdk").LinearClient;

// ---------------------------------------------------------------------------
// Payload factories
// ---------------------------------------------------------------------------

function makeCreatedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "AgentSessionEvent" as const,
    action: "created" as const,
    organizationId: "org-123",
    data: {
      id: "session-abc",
      agentSession: {
        id: "session-abc",
        actorId: "linear-user-1",
        promptContext: {
          issueId: "issue-xyz",
          issueIdentifier: "ENG-42",
          issueTitle: "Fix the bug",
          issueDescription: "Something is broken",
          issueUrl: "https://linear.app/team/issue/ENG-42",
          actorId: "linear-user-1",
        },
      },
    },
    ...overrides,
  };
}

function makePromptedPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "AgentSessionEvent" as const,
    action: "prompted" as const,
    organizationId: "org-123",
    data: {
      id: "session-abc",
      agentActivity: { body: "Continue the work please" },
      ...((overrides.data as Record<string, unknown>) ?? {}),
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) => k !== "data"),
    ),
  };
}

function makeAppUserNotificationPayload(
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "AppUserNotification" as const,
    organizationId: "org-123",
    notification: {
      type: "issueMention",
      user: { id: "linear-user-1" },
      issue: { id: "issue-xyz" },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe("handlers", () => {
  let user: User;

  beforeAll(async () => {
    await mockWaitUntil();

    const testUserResult = await createTestUser({ db });
    user = testUserResult.user;

    // Link a linear account
    await upsertLinearAccount({
      db,
      userId: user.id,
      organizationId: "org-123",
      account: {
        linearUserId: "linear-user-1",
        linearUserName: "Test User",
        linearUserEmail: "test@linear.app",
      },
    });

    // Create a linear installation for the org
    // Note: accessTokenEncrypted must be a real encrypted value in tests
    // that call refreshLinearTokenIfNeeded (which we mock), so any string is fine.
    await upsertLinearInstallation({
      db,
      installation: {
        organizationId: "org-123",
        organizationName: "Test Org",
        accessTokenEncrypted: "mock-encrypted-token",
        refreshTokenEncrypted: "mock-encrypted-refresh-token",
        tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h from now
        scope: "read,write",
        installerUserId: user.id,
        isActive: true,
      },
    });

    // Create linear settings with a default repo
    await upsertLinearSettings({
      db,
      userId: user.id,
      organizationId: "org-123",
      settings: {
        defaultRepoFullName: "owner/default-repo",
        defaultModel: "sonnet",
      },
    });

    // Enable the feature flag
    await setFeatureFlagOverrideForTest({
      db,
      userId: user.id,
      name: "linearIntegration",
      value: true,
    });
  });

  afterAll(() => {
    // nothing to tear down
  });

  beforeEach(async () => {
    // Drain any leftover promises from previous tests before clearing mocks
    await waitUntilResolved();
    vi.clearAllMocks();
    // Re-register mockWaitUntil after clearAllMocks resets the implementation
    await mockWaitUntil();
    vi.mocked(newThreadInternal).mockResolvedValue({
      threadId: "test-thread-id",
      threadChatId: "test-chat-id",
    });
    vi.mocked(queueFollowUpInternal).mockResolvedValue(undefined);
    mockCreateAgentActivity.mockResolvedValue({ success: true });
    mockUpdateAgentSession.mockResolvedValue({ success: true });
    mockIssueRepositorySuggestions.mockResolvedValue({
      suggestions: [
        {
          repositoryFullName: "owner/repo",
          hostname: "github.com",
          confidence: 0.9,
        },
      ],
    });
    // Restore refreshLinearTokenIfNeeded mock after clearAllMocks
    const { refreshLinearTokenIfNeeded } = await import(
      "@/server-lib/linear-oauth"
    );
    vi.mocked(refreshLinearTokenIfNeeded).mockResolvedValue({
      status: "ok",
      accessToken: "test-access-token",
    });
  });

  // -------------------------------------------------------------------------
  // AgentSessionEvent.created
  // -------------------------------------------------------------------------

  describe("handleAgentSessionEvent (created)", () => {
    it("emits thought activity synchronously before returning", async () => {
      const payload = makeCreatedPayload();

      await handleAgentSessionEvent(payload, "delivery-1", {
        createClient: mockClientFactory,
      });
      // Flush async waitUntil work
      await waitUntilResolved();

      // thought activity MUST have been emitted
      expect(mockCreateAgentActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: "session-abc",
          content: expect.objectContaining({ type: "thought" }),
        }),
      );
    });

    it("creates a thread via newThreadInternal with correct sourceMetadata", async () => {
      const payload = makeCreatedPayload();

      await handleAgentSessionEvent(payload, "delivery-2", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          sourceType: "linear-mention",
          sourceMetadata: expect.objectContaining({
            type: "linear-mention",
            agentSessionId: "session-abc",
            organizationId: "org-123",
            issueId: "issue-xyz",
            linearDeliveryId: "delivery-2",
          }),
        }),
      );
    });

    it("updates the agent session with the Terragon task URL", async () => {
      const payload = makeCreatedPayload();

      await handleAgentSessionEvent(payload, "delivery-3", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();

      expect(mockUpdateAgentSession).toHaveBeenCalledWith(
        "session-abc",
        expect.objectContaining({
          externalUrls: expect.arrayContaining([
            expect.stringContaining("test-thread-id"),
          ]),
        }),
      );
    });

    it("still returns (without crashing) if thought emission fails (SLA failure path)", async () => {
      // emitAgentActivity catches errors internally, so SLA failure means
      // the createAgentActivity mock rejects but handler continues
      mockCreateAgentActivity.mockRejectedValueOnce(
        new Error("Linear API down"),
      );

      const payload = makeCreatedPayload();

      // Should not throw
      await expect(
        handleAgentSessionEvent(payload, "delivery-sla", {
          createClient: mockClientFactory,
        }),
      ).resolves.not.toThrow();
    });

    it("skips if no linearInstallation found for org", async () => {
      const payload = makeCreatedPayload({ organizationId: "org-unknown" });

      await handleAgentSessionEvent(payload, "delivery-no-org", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();

      expect(newThreadInternal).not.toHaveBeenCalled();
    });

    it("is idempotent: does not create a second thread for same deliveryId", async () => {
      // We test idempotency by spying on getThreadByLinearDeliveryId to simulate
      // a thread already existing (since newThreadInternal is mocked and doesn't write to DB)
      const threadsModule = await import("@terragon/shared/model/threads");
      const spy = vi
        .spyOn(threadsModule, "getThreadByLinearDeliveryId")
        .mockResolvedValueOnce(null) // First call: no thread → create
        .mockResolvedValueOnce({
          id: "existing-thread-id",
        } as unknown as Awaited<
          ReturnType<typeof threadsModule.getThreadByLinearDeliveryId>
        >); // Second call: found → skip

      const payload = makeCreatedPayload();

      // First call creates the thread
      await handleAgentSessionEvent(payload, "delivery-idempotent-mock", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();
      expect(newThreadInternal).toHaveBeenCalledTimes(1);

      vi.mocked(newThreadInternal).mockClear();

      // Second call with same deliveryId should be idempotent (thread found → skip)
      await handleAgentSessionEvent(payload, "delivery-idempotent-mock", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();
      expect(newThreadInternal).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // AgentSessionEvent.prompted
  // -------------------------------------------------------------------------

  describe("handleAgentSessionEvent (prompted)", () => {
    it("logs warning and skips if no thread found for agentSessionId", async () => {
      const payload = makePromptedPayload({
        data: { id: "session-no-thread", agentActivity: { body: "Continue" } },
      });

      // Should not throw and should not queue follow-up
      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      expect(queueFollowUpInternal).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // AppUserNotification
  // -------------------------------------------------------------------------

  describe("handleAppUserNotification", () => {
    it("logs the notification but does NOT create a thread", async () => {
      const payload = makeAppUserNotificationPayload();

      await handleAppUserNotification(payload);

      expect(newThreadInternal).not.toHaveBeenCalled();
    });

    it("handles all notification types without throwing", async () => {
      for (const type of [
        "issueMention",
        "issueCommentMention",
        "issueAssignedToYou",
      ]) {
        await expect(
          handleAppUserNotification(
            makeAppUserNotificationPayload({
              notification: { type, user: { id: "u1" }, issue: { id: "i1" } },
            }),
          ),
        ).resolves.not.toThrow();
      }

      expect(newThreadInternal).not.toHaveBeenCalled();
    });

    it("does not throw on missing notification fields", async () => {
      await expect(
        handleAppUserNotification({
          type: "AppUserNotification",
          organizationId: "org-xyz",
        }),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Token refresh timeout path
  // -------------------------------------------------------------------------

  describe("token refresh handling", () => {
    it("returns without creating thread when token refresh times out", async () => {
      const { refreshLinearTokenIfNeeded } = await import(
        "@/server-lib/linear-oauth"
      );

      // Make token refresh hang for longer than our 2.5s budget
      vi.mocked(refreshLinearTokenIfNeeded).mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ status: "ok", accessToken: "late-token" }),
              10000,
            ),
          ),
      );

      const payload = makeCreatedPayload();

      // Should not throw
      await expect(
        handleAgentSessionEvent(payload, "delivery-timeout", {
          createClient: mockClientFactory,
        }),
      ).resolves.not.toThrow();
      await waitUntilResolved();

      // Thread should NOT have been created
      expect(newThreadInternal).not.toHaveBeenCalled();
    });

    it("returns without creating thread when reinstall_required", async () => {
      const { refreshLinearTokenIfNeeded } = await import(
        "@/server-lib/linear-oauth"
      );

      vi.mocked(refreshLinearTokenIfNeeded).mockResolvedValueOnce({
        status: "reinstall_required",
      });

      const payload = makeCreatedPayload();

      await handleAgentSessionEvent(payload, "delivery-reinstall", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();

      expect(newThreadInternal).not.toHaveBeenCalled();
      // Should emit error activity
      expect(mockCreateAgentActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.objectContaining({ type: "error" }),
        }),
      );
    });
  });
});
