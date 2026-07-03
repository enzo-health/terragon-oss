import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import type { AgUiHistoryMessagesResult } from "@/lib/ag-ui-history-types";
import { TranscriptStore } from "../transcript-store";
import { hydrateTranscriptFromHistory } from "./hydrate-history";

function makeResult(
  messages: AgUiHistoryMessagesResult["messages"],
): AgUiHistoryMessagesResult {
  return { messages, lastSeq: messages.length - 1, activeRunId: "run-1" };
}

describe("hydrateTranscriptFromHistory", () => {
  it("folds projected messages and interleaved data-parts in order", () => {
    const store = new TranscriptStore();
    hydrateTranscriptFromHistory(
      store,
      makeResult([
        { id: "u1", role: "user", content: "hello" } as never,
        { id: "a1", role: "assistant", content: "hi there" } as never,
        {
          type: EventType.CUSTOM,
          name: "terragon.data-part",
          value: {
            messageId: "a1",
            partIndex: 0,
            name: "terragon.diff",
            data: { filePath: "a.ts", newContent: "const a = 1;\n" },
          },
        } as never,
      ]),
    );

    const items = store.getItems();
    expect(items.map((item) => item.kind)).toEqual(["user", "text", "diff"]);
    expect(items[0]?.runId).toBe("run-1");
    const diff = items.find((item) => item.kind === "diff");
    expect(diff && diff.kind === "diff" ? diff.filePath : null).toBe("a.ts");
  });

  it("clears prior items when a compaction system message arrives", () => {
    const store = new TranscriptStore();
    hydrateTranscriptFromHistory(
      store,
      makeResult([
        { id: "u1", role: "user", content: "first" } as never,
        {
          id: "side-effect-system:compact-result-1",
          role: "system",
          content: "",
        } as never,
        { id: "u2", role: "user", content: "second" } as never,
      ]),
    );

    const items = store.getItems();
    expect(items.map((item) => item.kind)).toEqual(["compaction", "user"]);
  });
});
