import { describe, expect, it } from "vitest";
import type { DBUserMessage } from "@terragon/shared";
import {
  appendUniqueQueuedMessages,
  type QueuedUserMessage,
} from "./queued-message-dedupe";

function message(text: string): DBUserMessage {
  return {
    type: "user",
    model: "gpt-5.4",
    parts: [{ type: "text", text }],
    timestamp: "2026-05-23T00:00:00.000Z",
  };
}

function queuedMessage(
  text: string,
  clientSubmissionId: string,
): QueuedUserMessage {
  return {
    clientSubmissionId,
    message: message(text),
  };
}

describe("appendUniqueQueuedMessages", () => {
  it("appends new queued messages", () => {
    const base = [message("first")];
    const next = appendUniqueQueuedMessages(base, [
      queuedMessage("second", "submission-2"),
    ]);

    expect(next).toHaveLength(2);
    expect(next[1]?.parts).toEqual([{ type: "text", text: "second" }]);
    expect(next[1]).not.toHaveProperty("clientSubmissionId");
  });

  it("keeps two separate identical queued submissions", () => {
    const base = appendUniqueQueuedMessages(
      [],
      [queuedMessage("same", "submission-1")],
    );
    const next = appendUniqueQueuedMessages(base, [
      queuedMessage("same", "submission-2"),
    ]);

    expect(next).toHaveLength(2);
    expect(next[0]?.parts).toEqual([{ type: "text", text: "same" }]);
    expect(next[1]?.parts).toEqual([{ type: "text", text: "same" }]);
  });

  it("preserves the existing array when the same queued submission is retried", () => {
    const base = appendUniqueQueuedMessages(
      [],
      [queuedMessage("same", "submission-1")],
    );
    const next = appendUniqueQueuedMessages(base, [
      queuedMessage("same", "submission-1"),
    ]);

    expect(next).toBe(base);
  });

  it("preserves the existing array when the same message object is retried with a fresh id", () => {
    const retriedMessage = message("same");
    const base = appendUniqueQueuedMessages(
      [],
      [
        {
          clientSubmissionId: "submission-1",
          message: retriedMessage,
        },
      ],
    );
    const next = appendUniqueQueuedMessages(base, [
      {
        clientSubmissionId: "submission-2",
        message: retriedMessage,
      },
    ]);

    expect(next).toBe(base);
  });

  it("does not content-dedupe legacy queued messages without client identity", () => {
    const base = [message("same")];
    const next = appendUniqueQueuedMessages(base, [
      queuedMessage("same", "submission-1"),
    ]);

    expect(next).toHaveLength(2);
  });

  it("uses the caller-provided client submission identity", () => {
    const queuedUserMessage = queuedMessage("same", "submission-1");
    const next = appendUniqueQueuedMessages([], [queuedUserMessage]);

    expect(next[0]).toBe(queuedUserMessage.message);
    expect(next[0]).not.toHaveProperty("clientSubmissionId");
  });
});
