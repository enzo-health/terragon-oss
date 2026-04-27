import { describe, expect, it } from "vitest";
import { resolveImplementationRuntimeAdapter } from "@/agent/runtime/implementation-adapter";

const baseInput = {
  agentVersion: 1,
  normalizedModel: "model",
  prompt: "do the thing",
  permissionMode: "plan" as const,
  runId: "run-123",
  sessionId: "session-123",
  codexPreviousResponseId: "response-123",
  shouldUseCredits: false,
};

describe("startAgentMessage runtime adapter dispatch contracts", () => {
  it("selects Codex app-server transport with Codex session persistence fields", () => {
    const dispatch = resolveImplementationRuntimeAdapter(
      "codex",
    ).createDispatch({
      ...baseInput,
      agent: "codex",
    });

    expect(dispatch.transportMode).toBe("codex-app-server");
    expect(dispatch.protocolVersion).toBe(1);
    expect(dispatch.requestedSessionId).toBe("session-123");
    expect(dispatch.message.runtimeAdapterContract).toMatchObject({
      adapterId: "codex-app-server",
      session: {
        requestedSessionField: "sessionId",
        resolvedSessionField: "sessionId",
        previousResponseField: "codexPreviousResponseId",
      },
    });
  });

  it("selects Claude ACP transport when ACP is enabled", () => {
    const dispatch = resolveImplementationRuntimeAdapter(
      "claudeCode",
    ).createDispatch({
      ...baseInput,
      agent: "claudeCode",
      codexPreviousResponseId: null,
      enableAcpTransport: true,
    });

    expect(dispatch.transportMode).toBe("acp");
    expect(dispatch.protocolVersion).toBe(2);
    expect(dispatch.requestedSessionId).toBeNull();
    expect(dispatch.message.acpServerId).toBe("terragon-run-123");
    expect(dispatch.message.acpSessionId).toBe("session-123");
    expect(
      dispatch.message.runtimeAdapterContract.operations["permission-response"]
        .status,
    ).toBe("supported");
  });

  it("keeps legacy stream-json as explicit fallback with typed unsupported operations", () => {
    const dispatch = resolveImplementationRuntimeAdapter(
      "claudeCode",
    ).createDispatch({
      ...baseInput,
      agent: "claudeCode",
      codexPreviousResponseId: null,
      enableAcpTransport: false,
    });

    expect(dispatch.transportMode).toBe("legacy");
    expect(dispatch.protocolVersion).toBe(1);
    expect(dispatch.requestedSessionId).toBe("session-123");
    expect(
      dispatch.message.runtimeAdapterContract.operations["permission-response"],
    ).toMatchObject({
      status: "unsupported",
      recovery: "manual-intervention",
    });
  });
});
