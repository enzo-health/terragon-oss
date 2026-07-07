import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

vi.mock("@/agent/thread-resource", () => ({
  withThreadSandboxSession: vi.fn(),
}));

vi.mock("./checkpoint-thread-internal", () => ({
  checkpointThreadAndPush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/agent/update-status", () => ({
  updateThreadChatWithTransition: vi
    .fn()
    .mockResolvedValue({
      didUpdateStatus: true,
      updatedStatus: "checkpointing",
    }),
}));

vi.mock("@/server-lib/process-follow-up-queue", () => ({
  maybeProcessFollowUpQueue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./claude-session", () => ({
  maybeSaveClaudeSessionToR2: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/loops", () => ({
  sendLoopsTransactionalEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@terragon/shared/model/user", () => ({
  getUser: vi.fn().mockResolvedValue({ email: null }),
  getUserSettings: vi
    .fn()
    .mockResolvedValue({ autoCreatePRs: false, prType: "draft" }),
}));

vi.mock("@terragon/shared/model/feature-flags", () => ({
  getFeatureFlagForUser: vi.fn().mockResolvedValue(false),
}));

vi.mock("@terragon/shared/model/automations", () => ({
  getAutomation: vi.fn().mockResolvedValue(null),
}));

const getThreadMinimal = vi.fn();
const getThread = vi.fn();
const getThreadChat = vi.fn();
vi.mock("@terragon/shared/model/threads", () => ({
  getThreadMinimal: (...args: unknown[]) => getThreadMinimal(...args),
  getThread: (...args: unknown[]) => getThread(...args),
  getThreadChat: (...args: unknown[]) => getThreadChat(...args),
  updateThread: vi.fn().mockResolvedValue(undefined),
}));

const refreshLinearTokenIfNeeded = vi.fn();
vi.mock("@/server-lib/linear-oauth", () => ({
  refreshLinearTokenIfNeeded: (...args: unknown[]) =>
    refreshLinearTokenIfNeeded(...args),
}));

const updateAgentSession = vi.fn();
vi.mock("@/server-lib/linear-agent-activity", () => ({
  updateAgentSession: (...args: unknown[]) => updateAgentSession(...args),
}));

import { withThreadSandboxSession } from "@/agent/thread-resource";
import { checkpointThread } from "./checkpoint-thread";

async function runCheckpointExecPath() {
  const session = { sandboxId: "sandbox-1" };
  const threadChat = { agent: "codex" };
  vi.mocked(withThreadSandboxSession).mockImplementation(
    async ({ onBeforeExec, execOrThrow }: any) => {
      await onBeforeExec?.();
      await execOrThrow({ threadChat, session });
    },
  );
  await checkpointThread({
    userId: "user-1",
    threadId: "thread-1",
    threadChatId: "chat-1",
  });
}

describe("checkpointThread Linear PR-URL emission gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getThread.mockResolvedValue(null);
    getThreadChat.mockResolvedValue(null);
    refreshLinearTokenIfNeeded.mockResolvedValue({
      status: "ok",
      accessToken: "linear-token",
    });
    updateAgentSession.mockResolvedValue(undefined);
  });

  it("does not emit the Linear PR URL for a non-linear-mention thread", async () => {
    getThreadMinimal.mockResolvedValue({
      id: "thread-1",
      userId: "user-1",
      sourceType: "prompt",
      sourceMetadata: null,
      githubPRNumber: 42,
      githubRepoFullName: "terragon/test-repo",
    });

    await runCheckpointExecPath();

    expect(refreshLinearTokenIfNeeded).not.toHaveBeenCalled();
    expect(updateAgentSession).not.toHaveBeenCalled();
  });

  it("does not emit the Linear PR URL for a linear-mention thread without an open PR", async () => {
    getThreadMinimal.mockResolvedValue({
      id: "thread-1",
      userId: "user-1",
      sourceType: "linear-mention",
      sourceMetadata: {
        type: "linear-mention",
        agentSessionId: "agent-session-1",
        organizationId: "org-1",
      },
      githubPRNumber: null,
      githubRepoFullName: "terragon/test-repo",
    });

    await runCheckpointExecPath();

    expect(refreshLinearTokenIfNeeded).not.toHaveBeenCalled();
    expect(updateAgentSession).not.toHaveBeenCalled();
  });

  it("emits the Linear PR URL for a linear-mention thread with an open PR", async () => {
    getThreadMinimal.mockResolvedValue({
      id: "thread-1",
      userId: "user-1",
      sourceType: "linear-mention",
      sourceMetadata: {
        type: "linear-mention",
        agentSessionId: "agent-session-1",
        organizationId: "org-1",
      },
      githubPRNumber: 42,
      githubRepoFullName: "terragon/test-repo",
    });

    await runCheckpointExecPath();

    expect(refreshLinearTokenIfNeeded).toHaveBeenCalledWith("org-1", {});
    expect(updateAgentSession).toHaveBeenCalledWith({
      sessionId: "agent-session-1",
      accessToken: "linear-token",
      addedExternalUrls: [
        {
          label: "Pull Request",
          url: "https://github.com/terragon/test-repo/pull/42",
        },
      ],
    });
  });
});
