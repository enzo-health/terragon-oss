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
      replayCursorAction: "apply-history-last-seq",
      resumeOnLoad: true,
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
      replayCursorAction: "clear",
      resumeOnLoad: false,
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
});
