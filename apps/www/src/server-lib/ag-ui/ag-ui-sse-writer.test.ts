import { describe, test, expect } from "vitest";
import {
  encodeSseEvent,
  encodeSseComment,
  isXreadTimeoutError,
} from "@/server-lib/ag-ui/ag-ui-sse-writer";
import { EventType } from "@ag-ui/core";

describe("ag-ui-sse-writer", () => {
  describe("encodeSseEvent", () => {
    test("encodes event without id", () => {
      const event = {
        type: EventType.RUN_STARTED,
        threadId: "t1",
        runId: "r1",
      };
      const encoded = encodeSseEvent(event);
      const text = new TextDecoder().decode(encoded);
      expect(text).toMatch(/^data: .*RUN_STARTED.*\n\n$/s);
      expect(text).not.toContain("id:");
    });

    test("encodes event with id", () => {
      const event = {
        type: EventType.RUN_FINISHED,
        threadId: "t1",
        runId: "r1",
      };
      const encoded = encodeSseEvent(event, "42-0");
      const text = new TextDecoder().decode(encoded);
      expect(text).toContain("id: 42-0\n");
      expect(text).toContain("data: ");
      expect(text).toMatch(/\n\n$/);
    });
  });

  describe("encodeSseComment", () => {
    test("encodes SSE comment", () => {
      const encoded = encodeSseComment("keepalive");
      const text = new TextDecoder().decode(encoded);
      expect(text).toBe(": keepalive\n\n");
    });
  });

  describe("isXreadTimeoutError", () => {
    test("returns true for timeout errors", () => {
      expect(
        isXreadTimeoutError(new Error("local redis-http command timeout")),
      ).toBe(true);
      expect(isXreadTimeoutError(new Error("Connection timeout"))).toBe(true);
      expect(isXreadTimeoutError(new Error("Operation time out"))).toBe(true);
    });

    test("returns false for non-timeout errors", () => {
      expect(isXreadTimeoutError(new Error("connection refused"))).toBe(false);
      expect(isXreadTimeoutError(new Error("ECONNRESET"))).toBe(false);
    });

    test("returns false for non-Error values", () => {
      expect(isXreadTimeoutError("timeout")).toBe(false);
      expect(isXreadTimeoutError(null)).toBe(false);
      expect(isXreadTimeoutError(undefined)).toBe(false);
    });
  });
});
