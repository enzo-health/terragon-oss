import { describe, expect, it } from "vitest";
import { resolveRuntimeResumePolicy } from "./runtime-resume-policy";

describe("resolveRuntimeResumePolicy", () => {
  it("resolves active runtime resume policy", () => {
    expect(
      resolveRuntimeResumePolicy({
        isAgentWorking: true,
        threadChatId: "chat-1",
      }),
    ).toEqual({
      historyLoadKey: "chat-1:active",
      historyMode: "active-resume",
    });
  });

  it("resolves idle finalized history policy", () => {
    expect(
      resolveRuntimeResumePolicy({
        isAgentWorking: false,
        threadChatId: "chat-1",
      }),
    ).toEqual({
      historyLoadKey: "chat-1:idle",
      historyMode: "idle-finalized",
    });
  });

  it("includes retry nonce in the load key", () => {
    expect(
      resolveRuntimeResumePolicy({
        isAgentWorking: true,
        threadChatId: "chat-1",
        retryNonce: 2,
      }).historyLoadKey,
    ).toBe("chat-1:active:retry-2");
  });

  it("server-active overrides a stale-idle client signal (deadlock defused)", () => {
    const policy = resolveRuntimeResumePolicy({
      isAgentWorking: false,
      serverRunActive: true,
      threadChatId: "chat-1",
    });
    expect(policy.historyMode).toBe("active-resume");
    expect(policy.historyLoadKey).toBe("chat-1:active");
  });

  it("server-inactive does not force a stream closed while the client is optimistically working", () => {
    const policy = resolveRuntimeResumePolicy({
      isAgentWorking: true,
      serverRunActive: false,
      threadChatId: "chat-1",
    });
    expect(policy.historyMode).toBe("active-resume");
  });

  it("both signals idle resolves to a closed stream", () => {
    const policy = resolveRuntimeResumePolicy({
      isAgentWorking: false,
      serverRunActive: false,
      threadChatId: "chat-1",
    });
    expect(policy.historyMode).toBe("idle-finalized");
  });

  it("undefined serverRunActive falls back to isAgentWorking (server has not reported yet)", () => {
    expect(
      resolveRuntimeResumePolicy({
        isAgentWorking: false,
        serverRunActive: undefined,
        threadChatId: "chat-1",
      }).historyMode,
    ).toBe("idle-finalized");
  });
});
