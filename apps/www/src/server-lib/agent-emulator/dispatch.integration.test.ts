import {
  createTestThread,
  createTestUser,
} from "@terragon/shared/model/test-helpers";
import { getThreadChat } from "@terragon/shared/model/threads";
import * as schema from "@terragon/shared/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

vi.mock("@/agent/helpers/create-daemon-run", () => ({
  createDaemonRunCredentials: vi.fn(async () => ({
    token: "emulator-fake-token",
  })),
}));
vi.mock("./run-emulator", () => ({
  runEmulatorStream: vi.fn(async () => {}),
}));

import { createDaemonRunCredentials } from "@/agent/helpers/create-daemon-run";
import { dispatchAgentMessage } from "@/agent/msg/startAgentMessage";
import { runEmulatorStream } from "./run-emulator";
import { isAgentEmulatorEnabled } from "./enabled";

const originalFlag = process.env.TERRAGON_AGENT_EMULATOR;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TERRAGON_AGENT_EMULATOR = "1";
});

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env.TERRAGON_AGENT_EMULATOR;
  } else {
    process.env.TERRAGON_AGENT_EMULATOR = originalFlag;
  }
});

describe("agent emulator dispatch trigger", () => {
  it("fires the emulator from the real dispatch flow, minting creds and starting the stream", async () => {
    const { user } = await createTestUser({ db });
    const { threadId, threadChatId } = await createTestThread({
      db,
      userId: user.id,
      overrides: { sandboxProvider: "mock" },
      chatOverrides: { status: "queued" },
    });

    const result = await dispatchAgentMessage({
      db,
      userId: user.id,
      threadId,
      threadChatId,
      isNewThread: false,
      message: {
        type: "user",
        model: "sonnet",
        parts: [{ type: "text", text: "/emulate rate-limit please stream" }],
      },
    });

    expect(result.dispatchLaunched).toBe(true);

    const threadChat = await getThreadChat({
      db,
      userId: user.id,
      threadId,
      threadChatId,
    });
    expect(threadChat!.status).toBe("booting");

    const runContext = await db.query.agentRunContext.findFirst({
      where: and(
        eq(schema.agentRunContext.threadId, threadId),
        eq(schema.agentRunContext.threadChatId, threadChatId),
      ),
      orderBy: [desc(schema.agentRunContext.createdAt)],
    });
    expect(runContext).toBeDefined();
    expect(runContext!.agent).toBe("claudeCode");
    expect(runContext!.transportMode).toBe("acp");
    expect(runContext!.protocolVersion).toBe(2);

    expect(createDaemonRunCredentials).toHaveBeenCalledTimes(1);
    expect(createDaemonRunCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claudeCode",
        transportMode: "acp",
        protocolVersion: 2,
        runId: runContext!.runId,
        threadId,
        threadChatId,
      }),
    );

    expect(runEmulatorStream).toHaveBeenCalledTimes(1);
    expect(runEmulatorStream).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: runContext!.runId,
        token: "emulator-fake-token",
        threadId,
        threadChatId,
        userId: user.id,
        prompt: "please stream",
        scenario: expect.objectContaining({ name: "rate-limit" }),
      }),
    );
  });

  it("gates strictly on the flag and never enables in production", () => {
    expect(isAgentEmulatorEnabled({ flag: "1", nodeEnv: "development" })).toBe(
      true,
    );
    expect(isAgentEmulatorEnabled({ flag: "1", nodeEnv: "test" })).toBe(true);
    expect(isAgentEmulatorEnabled({ flag: "1", nodeEnv: "production" })).toBe(
      false,
    );
    expect(isAgentEmulatorEnabled({ flag: "", nodeEnv: "development" })).toBe(
      false,
    );
    expect(isAgentEmulatorEnabled({ flag: "0", nodeEnv: "development" })).toBe(
      false,
    );
  });
});
