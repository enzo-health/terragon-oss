import type { ThreadMessage } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import { projectRuntimeOwnedRows } from "./runtime-row-projection";

describe("projectRuntimeOwnedRows", () => {
  it("fills only runtime-owned rows when a runtime message has no projected parts", () => {
    const projectedTranscript = {
      source: "runtime" as const,
      messages: [{ id: "user-1", role: "user" as const, parts: [] }],
    };

    const runtimeMessages: ThreadMessage[] = [
      {
        id: "user-1",
        role: "user",
        createdAt: new Date(0),
        content: [{ type: "text", text: "fix it" }],
        attachments: [],
        metadata: { custom: {} },
      },
      {
        id: "assistant-1",
        role: "assistant",
        createdAt: new Date(0),
        content: [
          {
            type: "data",
            name: "unknown.part",
            data: { ignored: true },
          },
        ],
        status: { type: "complete", reason: "unknown" },
        metadata: {
          unstable_state: null,
          unstable_annotations: [],
          unstable_data: [],
          steps: [],
          custom: {},
        },
      },
    ];

    expect(
      projectRuntimeOwnedRows({
        runtimeMessages,
        projectedTranscript,
        agent: "codex",
      }),
    ).toEqual({
      source: "runtime",
      messages: [
        { id: "user-1", role: "user", parts: [] },
        { id: "assistant-1", role: "agent", agent: "codex", parts: [] },
      ],
    });
  });

  it("keeps runtime ownership empty before runtime messages exist", () => {
    expect(
      projectRuntimeOwnedRows({
        runtimeMessages: [],
        projectedTranscript: { source: "runtime", messages: [] },
        agent: "codex",
      }),
    ).toEqual({
      source: "runtime",
      messages: [],
    });
  });
});
