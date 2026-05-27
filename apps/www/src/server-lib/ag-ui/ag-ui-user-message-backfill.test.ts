import { describe, test, expect } from "vitest";
import { mergeMissingDbUserMessagesIntoHistory } from "@/server-lib/ag-ui/ag-ui-user-message-backfill";

describe("ag-ui-user-message-backfill", () => {
  describe("mergeMissingDbUserMessagesIntoHistory", () => {
    test("returns history unchanged when no DB messages", () => {
      const historyItems = [
        { role: "user", content: "hello", id: "msg-1" },
      ] as any[];
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
      ] as any[];
      const dbMessages = [
        { type: "user", id: "db-1", parts: [{ type: "text", text: "hello" }] },
      ] as any[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });
      expect(result).toBe(historyItems);
    });

    test("prepends DB user messages not in history", () => {
      const historyItems = [
        { role: "assistant", content: "response", id: "msg-2" },
      ] as any[];
      const dbMessages = [
        {
          type: "user",
          id: "db-1",
          parts: [{ type: "text", text: "missing user message" }],
        },
      ] as any[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });
      expect(result).not.toBe(historyItems);
      expect(result.length).toBe(2);
      expect(Reflect.get(result[0]!, "role")).toBe("user");
    });

    test("skips DB messages with empty text", () => {
      const historyItems = [] as any[];
      const dbMessages = [
        { type: "user", id: "db-1", parts: [{ type: "text", text: "" }] },
        {
          type: "user",
          id: "db-2",
          parts: [{ type: "image", image_url: "http://example.com/img.png" }],
        },
      ] as any[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });
      expect(result).toBe(historyItems);
    });

    test("skips non-user DB messages", () => {
      const historyItems = [] as any[];
      const dbMessages = [
        {
          type: "agent",
          id: "db-1",
          parts: [{ type: "text", text: "agent response" }],
        },
      ] as any[];
      const result = mergeMissingDbUserMessagesIntoHistory({
        historyItems,
        dbMessages,
      });
      expect(result).toBe(historyItems);
    });
  });
});
