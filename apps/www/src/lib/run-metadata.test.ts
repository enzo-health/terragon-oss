import { describe, expect, it } from "vitest";
import {
  decodeRunMetadata,
  encodeRunMetadata,
  getRunMetadataProps,
} from "./run-metadata";

describe("run metadata", () => {
  it("encodes assistant-ui runConfig custom payloads", () => {
    expect(
      encodeRunMetadata({
        selectedModel: "sonnet",
        permissionMode: "plan",
        traceId: "trace-1",
        intent: "resume",
        clientSubmissionId: "submission-1",
      }),
    ).toEqual({
      terragon: {
        selectedModel: "sonnet",
        permissionMode: "plan",
        traceId: "trace-1",
        intent: "resume",
        clientSubmissionId: "submission-1",
      },
    });
  });

  it("decodes the assistant-ui forwardedProps.runConfig layout", () => {
    const decoded = decodeRunMetadata({
      runConfig: {
        terragon: {
          selectedModel: "gpt-5.4",
          permissionMode: "allowAll",
          traceId: "trace-1",
          intent: "append",
          clientSubmissionId: "submission-1",
        },
      },
    });

    expect(decoded).toEqual({
      selectedModel: "gpt-5.4",
      invalidSelectedModel: null,
      permissionMode: "allowAll",
      traceId: "trace-1",
      intent: "append",
      clientSubmissionId: "submission-1",
    });
  });

  it("does not accept the legacy direct forwardedProps.terragon layout", () => {
    expect(
      getRunMetadataProps({
        terragon: { selectedModel: "sonnet" },
      }),
    ).toBeNull();
  });

  it("reads only the assistant-ui runtime layout when both layouts are present", () => {
    expect(
      decodeRunMetadata({
        runConfig: {
          terragon: { selectedModel: "sonnet", permissionMode: "plan" },
        },
        terragon: { selectedModel: "opus", permissionMode: "allowAll" },
      }),
    ).toEqual({
      selectedModel: "sonnet",
      invalidSelectedModel: null,
      permissionMode: "plan",
      traceId: null,
      intent: "append",
      clientSubmissionId: null,
    });
  });

  it("surfaces non-canonical models without casting", () => {
    expect(
      decodeRunMetadata({
        runConfig: { terragon: { selectedModel: "claude-3-5-sonnet" } },
      }),
    ).toEqual({
      selectedModel: null,
      invalidSelectedModel: "claude-3-5-sonnet",
      permissionMode: undefined,
      traceId: null,
      intent: "append",
      clientSubmissionId: null,
    });
  });
});
