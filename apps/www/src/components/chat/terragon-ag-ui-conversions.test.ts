import { describe, expect, it } from "vitest";
import { hydrateAssistantHistoryMessages } from "./assistant-history-hydration-adapter";
import { toAgUiMessages } from "./terragon-ag-ui-conversions";

describe("terragon AG UI conversions", () => {
  it("round-trips hydrated user file content into later AG UI run input", () => {
    const hydrated = hydrateAssistantHistoryMessages([
      {
        id: "user-with-file",
        role: "user",
        content: [
          { type: "text", text: "Read this file" },
          {
            type: "binary",
            mimeType: "application/pdf",
            data: "JVBERi0xLjQ=",
            filename: "brief.pdf",
          },
        ],
      },
    ]);

    const roundTripped = toAgUiMessages(hydrated);

    expect(roundTripped).toEqual([
      {
        id: "user-with-file",
        role: "user",
        content: [
          { type: "text", text: "Read this file" },
          {
            type: "binary",
            mimeType: "application/pdf",
            data: "JVBERi0xLjQ=",
            filename: "brief.pdf",
          },
        ],
      },
    ]);
  });
});
