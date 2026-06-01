import { env } from "@terragon/env/apps-www";
import { User } from "@terragon/shared";
import {
  upsertLinearAccount,
  upsertLinearInstallation,
  upsertLinearSettings,
} from "@terragon/shared/model/linear";
import {
  createTestUser,
  setFeatureFlagOverrideForTest,
} from "@terragon/shared/model/test-helpers";
import { encryptValue } from "@terragon/utils/encryption";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { db } from "@/lib/db";
import { queueFollowUpInternal } from "@/server-lib/follow-up";
import type { LinearClientFactory } from "@/server-lib/linear-agent-activity";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { mockWaitUntil, waitUntilResolved } from "@/test-helpers/mock-next";
import {
  handleAgentSessionEvent,
  handleAppUserNotification,
  isLinearBootstrapPromptDuplicate,
} from "./handlers";

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
const mockUpdateIssue = vi.fn().mockResolvedValue({ success: true });
const mockViewer = {
  id: "app-user-id",
  name: "Terragon Agent",
};
const mockViewerAccess = vi.fn();
const mockIssueState = {
  id: "state-started",
  name: "In Progress",
  type: "started",
  position: 1,
};
const mockIssueStates = {
  nodes: [mockIssueState],
};
const mockTeam = {
  id: "team-123",
  states: vi.fn().mockResolvedValue(mockIssueStates),
};
const mockCurrentState = {
  id: "state-backlog",
  name: "Backlog",
  type: "unstarted",
};
const mockIssue = {
  id: "issue-xyz",
  get state() {
    return Promise.resolve(mockCurrentState);
  },
  get team() {
    return Promise.resolve(mockTeam);
  },
  get delegate() {
    return Promise.resolve(null);
  },
};

const mockLinearClientInstance = {
  createAgentActivity: mockCreateAgentActivity,
  updateAgentSession: mockUpdateAgentSession,
  issueRepositorySuggestions: mockIssueRepositorySuggestions,
  issue: vi.fn().mockResolvedValue(mockIssue),
  updateIssue: mockUpdateIssue,
  get viewer() {
    mockViewerAccess();
    return Promise.resolve(mockViewer);
  },
};

vi.mock("@linear/sdk", () => ({
  LinearClient: vi.fn().mockImplementation(() => mockLinearClientInstance),
  AgentActivitySignal: {
    Auth: "auth",
    Continue: "continue",
    Select: "select",
    Stop: "stop",
  },
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
    promptContext: "Issue ENG-42: Fix the bug\n\nSomething is broken",
    agentSession: {
      id: "session-abc",
      creatorId: "linear-user-1",
      issueId: "issue-xyz",
      issue: {
        id: "issue-xyz",
        identifier: "ENG-42",
        title: "Fix the bug",
        url: "https://linear.app/team/issue/ENG-42",
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
    agentSession: {
      id: "session-abc",
    },
    agentActivity: {
      content: { type: "response", body: "Continue the work please" },
    },
    ...overrides,
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

    // Create a linear installation for the org.
    // accessTokenEncrypted must be a real encrypted value so that
    // the reinstall_required path (which calls decryptValue directly) works.
    const masterKey = env.ENCRYPTION_MASTER_KEY;
    await upsertLinearInstallation({
      db,
      installation: {
        organizationId: "org-123",
        organizationName: "Test Org",
        accessTokenEncrypted: encryptValue("stale-access-token", masterKey),
        refreshTokenEncrypted: encryptValue("mock-refresh-token", masterKey),
        tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h from now
        scope: "read,write",
        installerUserId: user.id,
        appUserId: "stored-app-user-id",
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
      model: "sonnet",
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
    mockUpdateIssue.mockResolvedValue({ success: true });
    mockLinearClientInstance.issue.mockResolvedValue(mockIssue);
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

      // Assert BEFORE flushing waitUntil — thought emission must happen
      // synchronously inside handleAgentSessionEvent (within SLA), not inside
      // the async waitUntil callback.
      expect(mockCreateAgentActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: "session-abc",
          content: expect.objectContaining({ type: "thought" }),
          ephemeral: true,
        }),
      );

      // Flush async waitUntil work for cleanup
      await waitUntilResolved();
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
            expect.objectContaining({
              label: "Terragon Task",
              url: expect.stringContaining("test-thread-id"),
            }),
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
      // Mock claimLinearWebhookDelivery to simulate the DB-level idempotency gate:
      // first call claims the delivery (claimed: true), second call finds it already
      // claimed (claimed: false) and skips thread creation.
      const linearModule = await import("@terragon/shared/model/linear");
      const spy = vi
        .spyOn(linearModule, "claimLinearWebhookDelivery")
        .mockResolvedValueOnce({ claimed: true }) // First call: claim succeeds → create
        .mockResolvedValueOnce({ claimed: false }); // Second call: already claimed → skip

      const payload = makeCreatedPayload();

      // First call creates the thread
      await handleAgentSessionEvent(payload, "delivery-idempotent-mock", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();
      expect(newThreadInternal).toHaveBeenCalledTimes(1);

      vi.mocked(newThreadInternal).mockClear();

      // Second call with same deliveryId should be idempotent (claim fails → skip)
      await handleAgentSessionEvent(payload, "delivery-idempotent-mock", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();
      expect(newThreadInternal).not.toHaveBeenCalled();

      spy.mockRestore();
    });

    it("surfaces delivery completion persistence failures so Linear can retry", async () => {
      const linearModule = await import("@terragon/shared/model/linear");
      const completeSpy = vi
        .spyOn(linearModule, "completeLinearWebhookDelivery")
        .mockRejectedValueOnce(new Error("completion write failed"));

      const payload = makeCreatedPayload();

      await expect(
        handleAgentSessionEvent(payload, "delivery-complete-fail", {
          createClient: mockClientFactory,
        }),
      ).rejects.toThrow("completion write failed");
      expect(completeSpy).toHaveBeenCalledOnce();
      completeSpy.mockRestore();
    });

    it("reconciles retries to an existing delivery-mapped thread without creating a duplicate", async () => {
      const linearModule = await import("@terragon/shared/model/linear");
      const threadsModule = await import("@terragon/shared/model/threads");
      const byDeliverySpy = vi
        .spyOn(threadsModule, "getThreadByLinearDeliveryId")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "existing-thread-id",
        } as Awaited<
          ReturnType<typeof threadsModule.getThreadByLinearDeliveryId>
        >);
      const completeSpy = vi
        .spyOn(linearModule, "completeLinearWebhookDelivery")
        .mockRejectedValueOnce(new Error("completion write failed"))
        .mockResolvedValueOnce(undefined);

      const payload = makeCreatedPayload();

      await expect(
        handleAgentSessionEvent(payload, "delivery-reconcile", {
          createClient: mockClientFactory,
        }),
      ).rejects.toThrow("completion write failed");
      expect(newThreadInternal).toHaveBeenCalledTimes(1);

      await handleAgentSessionEvent(payload, "delivery-reconcile", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();
      expect(newThreadInternal).toHaveBeenCalledTimes(1);
      expect(completeSpy).toHaveBeenCalledTimes(2);

      byDeliverySpy.mockRestore();
      completeSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // AgentSessionEvent.prompted
  // -------------------------------------------------------------------------

  describe("handleAgentSessionEvent (prompted)", () => {
    describe("isLinearBootstrapPromptDuplicate", () => {
      it("matches generated Linear assignment prompts across whitespace variations", () => {
        expect(
          isLinearBootstrapPromptDuplicate({
            issueIdentifier: "ENG-42",
            promptBody:
              "You were assigned a Linear issue ENG-42: Fix the bug\n\nPlease work on this task. Your work will be sent to the user once you're done.",
          }),
        ).toBe(true);

        expect(
          isLinearBootstrapPromptDuplicate({
            issueIdentifier: "ENG-42",
            promptBody:
              "  You were assigned a Linear issue ENG-42:   Fix the bug\t\nPlease work on this task.   Your work will be sent to the user once you're done.  ",
          }),
        ).toBe(true);
      });

      it("rejects malformed, partial, mismatched, and empty-identifier prompts", () => {
        expect(
          isLinearBootstrapPromptDuplicate({
            issueIdentifier: "ENG-42",
            promptBody:
              "You were assigned a Linear issue ENG-99: Fix the bug\n\nPlease work on this task. Your work will be sent to the user once you're done.",
          }),
        ).toBe(false);

        expect(
          isLinearBootstrapPromptDuplicate({
            issueIdentifier: "ENG-42",
            promptBody: "You were assigned a Linear issue ENG-42: Fix the bug",
          }),
        ).toBe(false);

        expect(
          isLinearBootstrapPromptDuplicate({
            issueIdentifier: "ENG-42",
            promptBody:
              "you were assigned a linear issue ENG-42: Fix the bug\n\nPlease work on this task. Your work will be sent to the user once you're done.",
          }),
        ).toBe(false);

        expect(
          isLinearBootstrapPromptDuplicate({
            issueIdentifier: "",
            promptBody:
              "You were assigned a Linear issue : Fix the bug\n\nPlease work on this task. Your work will be sent to the user once you're done.",
          }),
        ).toBe(false);
      });
    });

    it("logs warning and skips if no thread found for agentSessionId", async () => {
      const payload = makePromptedPayload({
        agentSession: { id: "session-no-thread" },
        agentActivity: { content: { type: "response", body: "Continue" } },
      });

      // Should not throw and should not queue follow-up
      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      expect(queueFollowUpInternal).not.toHaveBeenCalled();
    });

    it("creates the thread from a pre-thread repo selection prompt", async () => {
      const payload = makePromptedPayload({
        agentSession: {
          id: "session-prethread-select",
          creatorId: "linear-user-1",
          issueId: "issue-xyz",
          issue: {
            id: "issue-xyz",
            identifier: "ENG-42",
            title: "Fix the bug",
            url: "https://linear.app/team/issue/ENG-42",
          },
        },
        agentActivity: {
          content: { type: "prompt", body: "owner/selected-repo" },
        },
        promptContext: "Issue ENG-42: Fix the bug",
      });

      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          githubRepoFullName: "owner/selected-repo",
          sourceMetadata: expect.objectContaining({
            agentSessionId: "session-prethread-select",
            issueId: "issue-xyz",
          }),
        }),
      );
      expect(queueFollowUpInternal).not.toHaveBeenCalled();
    });

    it("skips prompted events for legacy Linear threads without session metadata", async () => {
      const threadsModule = await import("@terragon/shared/model/threads");

      const fakeThread = {
        id: "legacy-thread-id",
        userId: user.id,
        sourceMetadata: {
          organizationId: "org-123",
          issueId: "issue-xyz",
          issueIdentifier: "ENG-42",
          issueUrl: "https://linear.app/team/issue/ENG-42",
        },
      } as unknown as Awaited<
        ReturnType<typeof threadsModule.getThreadByLinearAgentSessionId>
      >;

      const spyBySessionId = vi
        .spyOn(threadsModule, "getThreadByLinearAgentSessionId")
        .mockResolvedValueOnce(fakeThread);

      const payload = makePromptedPayload({
        agentSession: { id: "session-legacy" },
        agentActivity: {
          content: { type: "response", body: "Please continue with the task." },
        },
      });

      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      expect(queueFollowUpInternal).not.toHaveBeenCalled();

      spyBySessionId.mockRestore();
    });

    it("skips Linear assignment replays delivered through promptContext", async () => {
      const threadsModule = await import("@terragon/shared/model/threads");

      const fakeThread = {
        id: "prompt-context-thread-id",
        userId: user.id,
        createdAt: new Date(Date.now() - 60_000),
        sourceMetadata: {
          type: "linear-mention",
          agentSessionId: "session-prompt-context",
          organizationId: "org-123",
          issueId: "issue-xyz",
          issueIdentifier: "ENG-42",
          issueUrl: "https://linear.app/team/issue/ENG-42",
        },
      } as unknown as Awaited<
        ReturnType<typeof threadsModule.getThreadByLinearAgentSessionId>
      >;

      const spyBySessionId = vi
        .spyOn(threadsModule, "getThreadByLinearAgentSessionId")
        .mockResolvedValueOnce(fakeThread);
      const spyGetThread = vi.spyOn(threadsModule, "getThread");

      const payload = makePromptedPayload({
        agentSession: { id: "session-prompt-context" },
        agentActivity: { content: { type: "response" } },
        promptContext: [
          "You were assigned a Linear issue ENG-42: Fix the bug",
          "",
          "**Context from Linear:**",
          '<issue identifier="ENG-42">',
          "<title>Fix the bug</title>",
          "</issue>",
          "",
          "Please work on this task. Your work will be sent to the user once you're done.",
        ].join("\n"),
      });

      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      expect(queueFollowUpInternal).not.toHaveBeenCalled();
      expect(spyGetThread).not.toHaveBeenCalled();

      spyBySessionId.mockRestore();
      spyGetThread.mockRestore();
    });

    it("queues follow-up when thread found for agentSessionId (happy path)", async () => {
      const threadsModule = await import("@terragon/shared/model/threads");
      const threadUtilsModule = await import(
        "@terragon/shared/utils/thread-utils"
      );

      // Stub thread lookup to return a fake thread with agentSessionId in metadata
      const fakeThread = {
        id: "prompted-thread-id",
        userId: user.id,
        sourceMetadata: {
          type: "linear-mention",
          agentSessionId: "session-abc",
          organizationId: "org-123",
        },
      } as unknown as Awaited<
        ReturnType<typeof threadsModule.getThreadByLinearAgentSessionId>
      >;

      const fakeThreadFull = {
        id: "prompted-thread-id",
        userId: user.id,
        threadChats: [{ id: "prompted-chat-id" }],
      } as unknown as Awaited<ReturnType<typeof threadsModule.getThread>>;

      const spyBySessionId = vi
        .spyOn(threadsModule, "getThreadByLinearAgentSessionId")
        .mockResolvedValueOnce(fakeThread);
      const spyGetThread = vi
        .spyOn(threadsModule, "getThread")
        .mockResolvedValueOnce(fakeThreadFull);
      const spyGetPrimary = vi
        .spyOn(threadUtilsModule, "getPrimaryThreadChat")
        .mockReturnValueOnce({ id: "prompted-chat-id" } as ReturnType<
          typeof threadUtilsModule.getPrimaryThreadChat
        >);

      const payload = makePromptedPayload({
        agentSession: { id: "session-abc" },
        agentActivity: {
          content: { type: "response", body: "Please continue with the task." },
        },
      });

      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      expect(queueFollowUpInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: user.id,
          threadId: "prompted-thread-id",
          threadChatId: "prompted-chat-id",
          messages: expect.arrayContaining([
            expect.objectContaining({
              parts: expect.arrayContaining([
                expect.objectContaining({
                  text: "Please continue with the task.",
                }),
              ]),
            }),
          ]),
        }),
      );

      spyBySessionId.mockRestore();
      spyGetThread.mockRestore();
      spyGetPrimary.mockRestore();
    });

    it("skips follow-up when prompted event arrives paired with create (fresh thread, no agent activity)", async () => {
      const threadsModule = await import("@terragon/shared/model/threads");
      const threadUtilsModule = await import(
        "@terragon/shared/utils/thread-utils"
      );

      const fakeThread = {
        id: "fresh-thread-id",
        userId: user.id,
        createdAt: new Date(),
        sourceMetadata: {
          type: "linear-mention",
          agentSessionId: "session-fresh",
          organizationId: "org-123",
        },
      } as unknown as Awaited<
        ReturnType<typeof threadsModule.getThreadByLinearAgentSessionId>
      >;

      const fakeThreadFull = {
        id: "fresh-thread-id",
        userId: user.id,
        threadChats: [
          {
            id: "fresh-chat-id",
            messages: [
              {
                type: "user",
                model: "sonnet",
                parts: [{ type: "text", text: "initial" }],
              },
            ],
          },
        ],
      } as unknown as Awaited<ReturnType<typeof threadsModule.getThread>>;

      const spyBySessionId = vi
        .spyOn(threadsModule, "getThreadByLinearAgentSessionId")
        .mockResolvedValueOnce(fakeThread);
      const spyGetThread = vi
        .spyOn(threadsModule, "getThread")
        .mockResolvedValueOnce(fakeThreadFull);
      const spyGetPrimary = vi
        .spyOn(threadUtilsModule, "getPrimaryThreadChat")
        .mockReturnValueOnce({
          id: "fresh-chat-id",
          messages: [
            {
              type: "user",
              model: "sonnet",
              parts: [{ type: "text", text: "initial" }],
            },
          ],
        } as unknown as ReturnType<
          typeof threadUtilsModule.getPrimaryThreadChat
        >);

      const payload = makePromptedPayload({
        agentSession: { id: "session-fresh" },
        agentActivity: {
          content: { type: "response", body: '<issue identifier="ENG-42"/>' },
        },
      });

      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      expect(queueFollowUpInternal).not.toHaveBeenCalled();

      spyBySessionId.mockRestore();
      spyGetThread.mockRestore();
      spyGetPrimary.mockRestore();
    });

    it("skips follow-up when Linear replays the assignment prompt after agent activity starts", async () => {
      const threadsModule = await import("@terragon/shared/model/threads");
      const threadUtilsModule = await import(
        "@terragon/shared/utils/thread-utils"
      );

      const fakeThread = {
        id: "active-thread-id",
        userId: user.id,
        createdAt: new Date(Date.now() - 60_000),
        sourceMetadata: {
          type: "linear-mention",
          agentSessionId: "session-active",
          organizationId: "org-123",
          issueId: "issue-xyz",
          issueIdentifier: "ENG-42",
          issueUrl: "https://linear.app/team/issue/ENG-42",
        },
      } as unknown as Awaited<
        ReturnType<typeof threadsModule.getThreadByLinearAgentSessionId>
      >;

      const fakeThreadFull = {
        id: "active-thread-id",
        userId: user.id,
        threadChats: [
          {
            id: "active-chat-id",
            messages: [
              {
                type: "user",
                model: "sonnet",
                parts: [{ type: "text", text: "initial" }],
              },
              {
                type: "agent",
                parts: [{ type: "text", text: "Starting" }],
              },
            ],
          },
        ],
      } as unknown as Awaited<ReturnType<typeof threadsModule.getThread>>;

      const spyBySessionId = vi
        .spyOn(threadsModule, "getThreadByLinearAgentSessionId")
        .mockResolvedValueOnce(fakeThread);
      const spyGetThread = vi
        .spyOn(threadsModule, "getThread")
        .mockResolvedValueOnce(fakeThreadFull);
      const spyGetPrimary = vi
        .spyOn(threadUtilsModule, "getPrimaryThreadChat")
        .mockReturnValueOnce({
          id: "active-chat-id",
          messages: [
            {
              type: "user",
              model: "sonnet",
              parts: [{ type: "text", text: "initial" }],
            },
            {
              type: "agent",
              parts: [{ type: "text", text: "Starting" }],
            },
          ],
        } as unknown as ReturnType<
          typeof threadUtilsModule.getPrimaryThreadChat
        >);

      const payload = makePromptedPayload({
        agentSession: { id: "session-active" },
        agentActivity: {
          content: {
            type: "response",
            body: [
              "You were assigned a Linear issue ENG-42: Fix the bug",
              "",
              "**Context from Linear:**",
              '<issue identifier="ENG-42">',
              "<title>Fix the bug</title>",
              "</issue>",
              "",
              "Please work on this task. Your work will be sent to the user once you're done.",
            ].join("\n"),
          },
        },
      });

      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      expect(queueFollowUpInternal).not.toHaveBeenCalled();

      spyBySessionId.mockRestore();
      spyGetThread.mockRestore();
      spyGetPrimary.mockRestore();
    });

    it("skips follow-up when prompted body is empty or whitespace", async () => {
      const threadsModule = await import("@terragon/shared/model/threads");

      const fakeThread = {
        id: "prompted-thread-id",
        userId: user.id,
        sourceMetadata: {
          type: "linear-mention",
          agentSessionId: "session-empty-body",
          organizationId: "org-123",
        },
      } as unknown as Awaited<
        ReturnType<typeof threadsModule.getThreadByLinearAgentSessionId>
      >;

      const spyBySessionId = vi
        .spyOn(threadsModule, "getThreadByLinearAgentSessionId")
        .mockResolvedValue(fakeThread);

      for (const body of ["", "   ", "\t\n"]) {
        vi.mocked(queueFollowUpInternal).mockClear();
        const payload = makePromptedPayload({
          agentSession: { id: "session-empty-body" },
          agentActivity: {
            content: { type: "response", body },
          },
        });
        await handleAgentSessionEvent(payload, undefined, {
          createClient: mockClientFactory,
        });
        expect(queueFollowUpInternal).not.toHaveBeenCalled();
      }

      spyBySessionId.mockRestore();
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

      // Make token refresh hang indefinitely — the handler's 2.5s budget will fire.
      vi.mocked(refreshLinearTokenIfNeeded).mockImplementationOnce(
        () => new Promise(() => {}), // never resolves
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
      // Error activity MUST be emitted using the stale installation token
      expect(mockCreateAgentActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          agentSessionId: "session-abc",
          content: expect.objectContaining({ type: "error" }),
        }),
      );
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

    it("handler resolves promptly even when error activity emission hangs (bounded latency)", async () => {
      const { refreshLinearTokenIfNeeded } = await import(
        "@/server-lib/linear-oauth"
      );

      // Timeout path: token refresh hangs indefinitely
      vi.mocked(refreshLinearTokenIfNeeded).mockImplementationOnce(
        () => new Promise(() => {}), // never resolves
      );

      // Error activity emission also hangs — handler must still return promptly
      mockCreateAgentActivity.mockImplementationOnce(
        () => new Promise(() => {}), // never resolves
      );

      const payload = makeCreatedPayload();

      const start = Date.now();
      await handleAgentSessionEvent(payload, "delivery-bounded", {
        createClient: mockClientFactory,
      });
      const elapsed = Date.now() - start;

      // Handler must resolve well within 10s even with hanging emission
      expect(elapsed).toBeLessThan(6000);
      expect(newThreadInternal).not.toHaveBeenCalled();
    }, 10000);
  });

  // -------------------------------------------------------------------------
  // Issue lifecycle (transition to started, set delegate)
  // -------------------------------------------------------------------------

  describe("issue lifecycle on creation", () => {
    it("transitions issue to started status and sets agent as delegate", async () => {
      const payload = makeCreatedPayload();

      await handleAgentSessionEvent(payload, "delivery-lifecycle", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();

      // Issue lifecycle calls are best-effort and may run asynchronously.
      // Give a small grace period for the Promise.all to complete.
      await new Promise((r) => setTimeout(r, 100));

      // Should have called updateIssue to set the started state
      expect(mockUpdateIssue).toHaveBeenCalledWith(
        "issue-xyz",
        expect.objectContaining({ stateId: "state-started" }),
      );

      // Should have called updateIssue to set the delegate
      expect(mockUpdateIssue).toHaveBeenCalledWith(
        "issue-xyz",
        expect.objectContaining({ delegateId: "stored-app-user-id" }),
      );
      expect(mockViewerAccess).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Stop signal handling
  // -------------------------------------------------------------------------

  describe("stop signal in prompted events", () => {
    it("calls stopThread when stop signal is received", async () => {
      const stopModule = await import("@/server-lib/stop-thread");
      const mockStopThread = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(stopModule, "stopThread").mockImplementation(mockStopThread);

      const threadsModule = await import("@terragon/shared/model/threads");
      const spyBySessionId = vi
        .spyOn(threadsModule, "getThreadByLinearAgentSessionId")
        .mockResolvedValueOnce({
          id: "stop-thread-id",
          userId: user.id,
          sourceMetadata: {
            type: "linear-mention",
            agentSessionId: "session-stop",
            organizationId: "org-123",
          },
        } as unknown as Awaited<
          ReturnType<typeof threadsModule.getThreadByLinearAgentSessionId>
        >);

      const payload = makePromptedPayload({
        agentSession: { id: "session-stop" },
        agentActivity: {
          content: { type: "prompt", body: "Stop working" },
          signal: "stop",
        },
      });

      await handleAgentSessionEvent(payload, undefined, {
        createClient: mockClientFactory,
      });

      // Should NOT queue a follow-up — it should stop the thread
      expect(queueFollowUpInternal).not.toHaveBeenCalled();

      spyBySessionId.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Select signal for repo selection
  // -------------------------------------------------------------------------

  describe("select signal for repo selection", () => {
    it("falls back to default repo when suggestions have low confidence and default is set", async () => {
      // Return low-confidence suggestions — but since default repo is set,
      // the handler should fall back to using the default repo
      mockIssueRepositorySuggestions.mockResolvedValueOnce({
        suggestions: [
          {
            repositoryFullName: "owner/repo-a",
            hostname: "github.com",
            confidence: 0.3,
          },
          {
            repositoryFullName: "owner/repo-b",
            hostname: "github.com",
            confidence: 0.25,
          },
        ],
      });

      const payload = makeCreatedPayload();

      await handleAgentSessionEvent(payload, "delivery-low-confidence", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();

      // Should have created a thread using the explicit user default repo.
      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          githubRepoFullName: "owner/default-repo",
        }),
      );
    });

    it("emits elicitation without repo when no candidates and no default", async () => {
      // Override environments to return empty list (no repos at all)
      const envModule = await import("@terragon/shared/model/environments");
      vi.spyOn(envModule, "getEnvironments").mockResolvedValueOnce([]);

      // Override settings to return no default repo
      const linearModel = await import("@terragon/shared/model/linear");
      const settingsSpy = vi
        .spyOn(linearModel, "getLinearSettingsForUserAndOrg")
        .mockResolvedValueOnce(null);

      const payload = makeCreatedPayload();

      await handleAgentSessionEvent(payload, "delivery-no-repo", {
        createClient: mockClientFactory,
      });
      await waitUntilResolved();

      // Should have emitted an elicitation asking user to configure a repo
      const calls = mockCreateAgentActivity.mock.calls;
      const elicitationCall = calls.find(
        (c: any) => c[0]?.content?.type === "elicitation",
      );
      expect(elicitationCall).toBeDefined();
      expect(elicitationCall![0].content.body).toContain(
        "configure a default repository",
      );

      // Should NOT have created a thread
      expect(newThreadInternal).not.toHaveBeenCalled();

      settingsSpy.mockRestore();
    });

    it("round-trips low-confidence repo selection through prompted idempotency", async () => {
      const envModule = await import("@terragon/shared/model/environments");
      const linearModel = await import("@terragon/shared/model/linear");
      const environments = [
        { repoFullName: "owner/repo-a" },
        { repoFullName: "owner/repo-b" },
      ] as Awaited<ReturnType<typeof envModule.getEnvironments>>;
      const envSpy = vi
        .spyOn(envModule, "getEnvironments")
        .mockResolvedValue(environments);
      const settingsSpy = vi
        .spyOn(linearModel, "getLinearSettingsForUserAndOrg")
        .mockResolvedValue(null);
      mockIssueRepositorySuggestions.mockResolvedValue({
        suggestions: [
          {
            repositoryFullName: "owner/repo-a",
            hostname: "github.com",
            confidence: 0.3,
          },
          {
            repositoryFullName: "owner/repo-b",
            hostname: "github.com",
            confidence: 0.25,
          },
        ],
      });

      await handleAgentSessionEvent(
        makeCreatedPayload({
          agentSession: {
            id: "session-select-roundtrip",
            creatorId: "linear-user-1",
            issueId: "issue-xyz",
            issue: {
              id: "issue-xyz",
              identifier: "ENG-42",
              title: "Fix the bug",
              url: "https://linear.app/team/issue/ENG-42",
            },
          },
        }),
        "delivery-select-created",
        { createClient: mockClientFactory },
      );

      const selectCall = mockCreateAgentActivity.mock.calls.find(
        (call) => call[0]?.signal === "select",
      );
      expect(selectCall).toBeDefined();
      expect(newThreadInternal).not.toHaveBeenCalled();

      const promptedPayload = makePromptedPayload({
        agentSession: {
          id: "session-select-roundtrip",
          creatorId: "linear-user-1",
          issueId: "issue-xyz",
          issue: {
            id: "issue-xyz",
            identifier: "ENG-42",
            title: "Fix the bug",
            url: "https://linear.app/team/issue/ENG-42",
          },
        },
        agentActivity: {
          content: { type: "prompt", body: "owner/repo-a" },
        },
        promptContext: "Issue ENG-42: Fix the bug",
      });

      await handleAgentSessionEvent(promptedPayload, "delivery-select-prompt", {
        createClient: mockClientFactory,
      });

      expect(newThreadInternal).toHaveBeenCalledTimes(1);
      expect(newThreadInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          githubRepoFullName: "owner/repo-a",
          sourceMetadata: expect.objectContaining({
            agentSessionId: "session-select-roundtrip",
            linearDeliveryId: "delivery-select-prompt",
          }),
        }),
      );

      vi.mocked(newThreadInternal).mockClear();
      await handleAgentSessionEvent(promptedPayload, "delivery-select-prompt", {
        createClient: mockClientFactory,
      });
      expect(newThreadInternal).not.toHaveBeenCalled();

      envSpy.mockRestore();
      settingsSpy.mockRestore();
    });
  });
});
