import { describe, test, expect } from "vitest";
import type { Message } from "@ag-ui/core";
import type { DBMessage } from "@terragon/shared";
import { mergeMissingDbUserMessagesIntoHistory } from "@/server-lib/ag-ui/ag-ui-user-message-backfill";
import type { DurableAgUiHistoryItem } from "@/server-lib/ag-ui-side-effect-messages";

describe("ag-ui-user-message-backfill", () => {
  describe("mergeMissingDbUserMessagesIntoHistory", () => {
    test("returns history unchanged when no DB messages", () => {
      const historyItems = [
        { role: "user", content: "hello", id: "msg-1" },
      ] satisfies Message[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages: [],
      });
      expect(result).toBe(historyItems);
    });

    test("returns history unchanged when DB messages are already in history", () => {
      const historyItems = [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          id: "msg-1",
        },
      ] satisfies Message[];
      const dbMessages = [
        { type: "user", model: null, parts: [{ type: "text", text: "hello" }] },
      ] satisfies DBMessage[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });
      expect(result).toBe(historyItems);
    });

    test("prepends DB user messages not in history", () => {
      const historyItems = [
        { role: "assistant", content: "response", id: "msg-2" },
      ] satisfies Message[];
      const dbMessages = [
        {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "missing user message" }],
        },
      ] satisfies DBMessage[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });
      expect(result).not.toBe(historyItems);
      expect(result.length).toBe(2);
      expect(Reflect.get(result[0]!, "role")).toBe("user");
    });

    test("appends missing DB assistant text after a matched runtime user message", () => {
      const historyItems = [
        { role: "user", content: "show scheduling", id: "msg-1" },
      ] satisfies Message[];
      const dbMessages = [
        {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "show scheduling" }],
        },
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "Scheduling works like this." }],
        },
      ] satisfies DBMessage[];

      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });

      expect(result).not.toBe(historyItems);
      expect(result).toEqual([
        { role: "user", content: "show scheduling", id: "msg-1" },
        {
          id: "db-agent-backfill-1",
          role: "assistant",
          content: "Scheduling works like this.",
        },
      ]);
    });

    test("restores DB user and assistant text when runtime history is empty", () => {
      const historyItems: DurableAgUiHistoryItem[] = [];
      const dbMessages = [
        {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "give me an overview" }],
        },
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "Here is the overview." }],
        },
      ] satisfies DBMessage[];

      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });

      expect(result).toEqual([
        expect.objectContaining({
          role: "user",
          content: "give me an overview",
        }),
        {
          id: "db-agent-backfill-1",
          role: "assistant",
          content: "Here is the overview.",
        },
      ]);
    });

    test("preserves DB turn order while restoring missing assistant text", () => {
      const historyItems: DurableAgUiHistoryItem[] = [];
      const dbMessages = [
        {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "first question" }],
        },
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "first answer" }],
        },
        {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "second question" }],
        },
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "second answer" }],
        },
      ] satisfies DBMessage[];

      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });

      expect(
        result.map((item) => [
          Reflect.get(item, "role"),
          Reflect.get(item, "content"),
        ]),
      ).toEqual([
        ["user", "first question"],
        ["assistant", "first answer"],
        ["user", "second question"],
        ["assistant", "second answer"],
      ]);
    });

    test("keeps DB assistant text as its own backfilled turn when durable history has only a tool shell", () => {
      const historyItems: DurableAgUiHistoryItem[] = [
        { role: "user", content: "inspect", id: "msg-1" },
        {
          id: "assistant-tool-only",
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              type: "function",
              function: { name: "Bash", arguments: "{}" },
            },
          ],
        },
      ];
      const dbMessages = [
        {
          type: "user",
          model: null,
          parts: [{ type: "text", text: "inspect" }],
        },
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "I inspected it." }],
        },
      ] satisfies DBMessage[];

      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });

      expect(result).toEqual([
        historyItems[0],
        historyItems[1],
        {
          id: "db-agent-backfill-1",
          role: "assistant",
          content: "I inspected it.",
        },
      ]);
    });

    test("skips DB messages with empty text", () => {
      const historyItems: DurableAgUiHistoryItem[] = [];
      const dbMessages = [
        { type: "user", model: null, parts: [{ type: "text", text: "" }] },
        {
          type: "user",
          model: null,
          parts: [
            {
              type: "image",
              mime_type: "image/png",
              image_url: "http://example.com/img.png",
            },
          ],
        },
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "" }],
        },
      ] satisfies DBMessage[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });
      expect(result).toBe(historyItems);
    });

    test("skips non-text DB messages", () => {
      const historyItems: DurableAgUiHistoryItem[] = [];
      const dbMessages = [
        {
          type: "git-diff",
          diff: "diff --git a/file b/file",
        },
      ] satisfies DBMessage[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });
      expect(result).toBe(historyItems);
    });
  });
});
