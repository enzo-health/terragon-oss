import { describe, expect, it } from "vitest";
import type { DBUserMessage } from "@terragon/shared";
import { appendUniqueQueuedMessages } from "./queued-message-dedupe";

function message(text: string): DBUserMessage {
  return {
    type: "user",
    model: "gpt-5.4",
    parts: [{ type: "text", text }],
    timestamp: "2026-05-23T00:00:00.000Z",
  };
}

describe("appendUniqueQueuedMessages", () => {
  it("appends new queued messages", () => {
    const base = [message("first")];
    const next = appendUniqueQueuedMessages(base, [message("second")]);

    expect(next).toHaveLength(2);
    expect(next[1]?.parts).toEqual([{ type: "text", text: "second" }]);
  });

  it("preserves the existing array when a queued message is already present", () => {
    const base = [message("same")];
    const next = appendUniqueQueuedMessages(base, [message("same")]);

    expect(next).toBe(base);
  });
});
