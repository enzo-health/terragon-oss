import type {
  DaemonTransportMode,
  RuntimeAdapterContract,
  RuntimeAdapterOperation,
  RuntimeAdapterOperationSupport,
} from "./shared";

type UnsupportedRuntimeOperationRecovery =
  | "retry-new-run"
  | "manual-intervention"
  | "legacy-fallback";

type UnsupportedRuntimeOperationDetails = {
  reason: string;
  recovery: UnsupportedRuntimeOperationRecovery;
};

export function unsupportedRuntimeOperation(
  reason: string,
  recovery: UnsupportedRuntimeOperationRecovery,
): RuntimeAdapterOperationSupport {
  return { status: "unsupported", reason, recovery };
}

export function createRuntimeOperations(
  supported: readonly RuntimeAdapterOperation[],
  unsupported: Partial<
    Record<RuntimeAdapterOperation, UnsupportedRuntimeOperationDetails>
  >,
): Record<RuntimeAdapterOperation, RuntimeAdapterOperationSupport> {
  const supportedSet = new Set<RuntimeAdapterOperation>(supported);
  function supportFor(
    operation: RuntimeAdapterOperation,
  ): RuntimeAdapterOperationSupport {
    if (supportedSet.has(operation)) {
      return { status: "supported" };
    }
    const details = unsupported[operation] ?? {
      reason: `${operation} is not implemented by this runtime adapter`,
      recovery: "manual-intervention",
    };
    return unsupportedRuntimeOperation(details.reason, details.recovery);
  }
  return {
    start: supportFor("start"),
    resume: supportFor("resume"),
    stop: supportFor("stop"),
    restart: supportFor("restart"),
    retry: supportFor("retry"),
    "permission-response": supportFor("permission-response"),
    "event-normalization": supportFor("event-normalization"),
    "compact-and-retry": supportFor("compact-and-retry"),
    "human-intervention": supportFor("human-intervention"),
  } satisfies Record<RuntimeAdapterOperation, RuntimeAdapterOperationSupport>;
}

export const codexRuntimeAdapterContract: RuntimeAdapterContract = {
  adapterId: "codex-app-server",
  transportMode: "codex-app-server",
  protocolVersion: 1,
  session: {
    requestedSessionField: "sessionId",
    resolvedSessionField: "sessionId",
    previousResponseField: "codexPreviousResponseId",
  },
  operations: createRuntimeOperations(
    ["start", "resume", "stop", "retry", "event-normalization"],
    {
      restart: {
        reason:
          "Codex app-server process restarts are operational recovery; user restart/retry is a new run.",
        recovery: "retry-new-run",
      },
      "permission-response": {
        reason:
          "Codex app-server does not expose Terragon-addressable pending permission requests.",
        recovery: "manual-intervention",
      },
      "compact-and-retry": {
        reason:
          "Compaction is emitted as a typed recovery result before starting another Codex turn.",
        recovery: "retry-new-run",
      },
      "human-intervention": {
        reason:
          "Human intervention is surfaced as a terminal recovery result, not a Codex app-server operation.",
        recovery: "manual-intervention",
      },
    },
  ),
};

export const claudeAcpRuntimeAdapterContract: RuntimeAdapterContract = {
  adapterId: "claude-acp",
  transportMode: "acp",
  protocolVersion: 2,
  session: {
    requestedSessionField: "acpSessionId",
    resolvedSessionField: "acpSessionId",
    previousResponseField: null,
  },
  operations: createRuntimeOperations(
    [
      "start",
      "resume",
      "stop",
      "retry",
      "permission-response",
      "event-normalization",
    ],
    {
      restart: {
        reason:
          "Claude ACP server restart is sandbox-agent bootstrap recovery; user retry starts a fresh run.",
        recovery: "retry-new-run",
      },
      "compact-and-retry": {
        reason:
          "Compaction is emitted as a typed recovery result before another ACP run.",
        recovery: "retry-new-run",
      },
      "human-intervention": {
        reason:
          "Human intervention is surfaced as a terminal recovery result, not an ACP operation.",
        recovery: "manual-intervention",
      },
    },
  ),
};

export const legacyRuntimeAdapterContract: RuntimeAdapterContract = {
  adapterId: "legacy",
  transportMode: "legacy",
  protocolVersion: 1,
  session: {
    requestedSessionField: "sessionId",
    resolvedSessionField: "sessionId",
    previousResponseField: null,
  },
  operations: createRuntimeOperations(
    ["start", "resume", "stop", "retry", "event-normalization"],
    {
      restart: {
        reason:
          "Legacy stream-json processes are single-turn child processes; restart is represented as a new run.",
        recovery: "retry-new-run",
      },
      "permission-response": {
        reason:
          "Legacy stream-json permission prompts are not addressable by daemon operation id.",
        recovery: "manual-intervention",
      },
      "compact-and-retry": {
        reason:
          "Compaction is handled before dispatch and retried as a fresh legacy run.",
        recovery: "retry-new-run",
      },
      "human-intervention": {
        reason:
          "Human intervention is surfaced as a terminal recovery result, not a legacy adapter operation.",
        recovery: "manual-intervention",
      },
    },
  ),
};

export function getRuntimeAdapterContract(
  transportMode: DaemonTransportMode,
): RuntimeAdapterContract {
  switch (transportMode) {
    case "codex-app-server":
      return codexRuntimeAdapterContract;
    case "acp":
      return claudeAcpRuntimeAdapterContract;
    case "legacy":
      return legacyRuntimeAdapterContract;
  }
}
