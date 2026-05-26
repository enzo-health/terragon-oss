import { describe, expect, it } from "vitest";
import { parseAgUiHistoryMessagesResponse } from "./ag-ui-history-fetch";

describe("parseAgUiHistoryMessagesResponse", () => {
  it("preserves projection-aware history cursors", () => {
    const result = parseAgUiHistoryMessagesResponse({
      messages: [{ id: "user-1", role: "user", content: "hello" }],
      lastSeq: 42,
      lastCursor: { seq: 42, projectionIndex: 1 },
    });

    expect(result.lastCursor).toEqual({ seq: 42, projectionIndex: 1 });
  });
});
