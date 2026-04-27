import fs from "node:fs";
import { nanoid } from "nanoid/non-secure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claudeAcpRuntimeAdapterContract } from "../../../apps/www/src/agent/runtime/claude-code-implementation-adapter";
import { codexRuntimeAdapterContract } from "../../../apps/www/src/agent/runtime/codex-implementation-adapter";
import { legacyRuntimeAdapterContract } from "../../../apps/www/src/agent/runtime/implementation-adapter";
import {
  createDaemonRuntimeAdapterContract,
  DaemonRuntime,
  getRuntimeAdapterLifecycleOperation,
  hasRuntimeAdapterContractDrift,
  requireRuntimeAdapterOperation,
  resolveDaemonRuntimeAdapterContract,
  runtimeAdapterUnsupportedOperationToMessage,
  writeToUnixSocket,
} from "./runtime";
import {
  RuntimeAdapterContract,
  RuntimeAdapterOperationSchema,
} from "./shared";

async function sleep(ms: number = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMockCalls(
  mockFn: { mock: { calls: unknown[] } },
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (mockFn.mock.calls.length === 0) {
    if (Date.now() - startedAt > timeoutMs) {
      return;
    }
    await sleep(10);
  }
}

describe("runtime", () => {
  let runtime: DaemonRuntime;

  beforeEach(() => {
    const unixSocketPath = `/tmp/terragon-daemon-${nanoid()}.sock`;
    runtime = new DaemonRuntime({
      url: "http://localhost:3000",
      unixSocketPath,
      outputFormat: "text",
    });
    vi.spyOn(runtime, "exitProcess").mockImplementation(() => {});
  });

  afterEach(async () => {
    await runtime.teardown();
    vi.clearAllMocks();
  });

  it("unix socket is created on construction and removed on teardown", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(runtime.unixSocketPath)).toBe(true);
    await runtime.teardown();
    expect(fs.existsSync(runtime.unixSocketPath)).toBe(false);
  });

  it("can read and write a single message to a unix socket", async () => {
    const messages: string[] = [];
    await runtime.listenToUnixSocket((message) => {
      messages.push(JSON.parse(message));
    });
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify({ message: "Hello, world!" }),
    });
    await sleep(10);
    expect(messages).toContainEqual({ message: "Hello, world!" });
  });

  it("handles errors from the unix socket", async () => {
    const messages: string[] = [];
    await runtime.listenToUnixSocket((msg) => {
      if (msg === "error") {
        throw new Error("Test error");
      } else {
        messages.push(msg);
      }
    });
    expect(
      writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: "error",
      }),
    ).rejects.toThrow("Test error");
    await sleep(10);
    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: "Hello, world!",
    });
    expect(messages).toContainEqual("Hello, world!");
  });

  it("can read and write multiple messages to a unix socket", async () => {
    const messages: string[] = [];
    await runtime.listenToUnixSocket((message) => {
      messages.push(JSON.parse(message));
    });
    const testMessages = [
      "Hello, world!",
      { test: 1 },
      { test: "Hello, world!" },
    ];
    for (const message of testMessages) {
      await writeToUnixSocket({
        unixSocketPath: runtime.unixSocketPath,
        dataStr: JSON.stringify(message),
      });
      // Add small delay between writes to ensure they don't interfere
      await sleep(10);
    }
    // Wait for messages to be processed with retries
    let retries = 0;
    const maxRetries = 20;
    while (messages.length < testMessages.length && retries < maxRetries) {
      await sleep(50);
      retries++;
    }

    expect(messages.length).toBe(testMessages.length);
    for (const message of testMessages) {
      expect(messages).toContainEqual(message);
    }
  });

  it("spawnCommandLine works", async () => {
    const onStdoutLineMock = vi.fn();
    const onStderrMock = vi.fn();
    const onErrorMock = vi.fn();
    const onCloseMock = vi.fn();

    runtime.spawnCommandLine("echo 'Hello, world!'", {
      onStdoutLine: onStdoutLineMock,
      onStderr: onStderrMock,
      onError: onErrorMock,
      onClose: onCloseMock,
      env: {},
    });
    await waitForMockCalls(onCloseMock);
    await sleep(10);
    expect(onStdoutLineMock).toHaveBeenCalledWith("Hello, world!");
    expect(onStderrMock).not.toHaveBeenCalled();
    expect(onErrorMock).not.toHaveBeenCalled();
    expect(onCloseMock).toHaveBeenCalledWith(0);
  });

  it("spawnCommandLine works with multiline output", async () => {
    const onStdoutMock = vi.fn();
    const onStderrMock = vi.fn();
    const onErrorMock = vi.fn();
    const onCloseMock = vi.fn();
    runtime.spawnCommandLine(
      "printf 'Hello, world!\\nHello, 2!\\nHello, 3!\\n'",
      {
        onStdoutLine: onStdoutMock,
        onStderr: onStderrMock,
        onError: onErrorMock,
        onClose: onCloseMock,
        env: {},
      },
    );
    await waitForMockCalls(onCloseMock);
    await sleep(10);
    expect(onStdoutMock).toHaveBeenCalledTimes(3);
    expect(onStdoutMock).toHaveBeenNthCalledWith(1, "Hello, world!");
    expect(onStdoutMock).toHaveBeenNthCalledWith(2, "Hello, 2!");
    expect(onStdoutMock).toHaveBeenNthCalledWith(3, "Hello, 3!");
    expect(onStderrMock).not.toHaveBeenCalled();
    expect(onErrorMock).not.toHaveBeenCalled();
    expect(onCloseMock).toHaveBeenCalledWith(0);
  });

  it("spawnCommandLine works with errors", async () => {
    const onStdoutLineMock = vi.fn();
    const onStderrMock = vi.fn();
    const onErrorMock = vi.fn();
    const onCloseMock = vi.fn();

    runtime.spawnCommandLine("sh -c '>&2 echo error message && exit 1'", {
      onStdoutLine: onStdoutLineMock,
      onStderr: onStderrMock,
      onError: onErrorMock,
      onClose: onCloseMock,
      env: {},
    });

    // Wait for the process to complete
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (onCloseMock.mock.calls.length > 0) {
          clearInterval(checkInterval);
          resolve(undefined);
        }
      }, 10);

      // Timeout after 1 second
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(undefined);
      }, 1000);
    });

    expect(onStdoutLineMock).not.toHaveBeenCalled();
    expect(onErrorMock).not.toHaveBeenCalled();
    expect(onStderrMock).toHaveBeenCalledWith("error message\n");
    expect(onCloseMock).toHaveBeenCalledWith(1);
  });

  it("execSync works", async () => {
    const result = runtime.execSync("echo 'Hello, world!'");
    expect(result).toBe("Hello, world!\n");
  });

  it("spawnCommand works with raw streaming", async () => {
    const onStdoutMock = vi.fn();
    const onStderrMock = vi.fn();
    const onErrorMock = vi.fn();
    const onCloseMock = vi.fn();

    runtime.spawnCommand("echo -n 'Hello, world!'", {
      onStdout: onStdoutMock,
      onStderr: onStderrMock,
      onError: onErrorMock,
      onClose: onCloseMock,
      env: {},
    });
    await waitForMockCalls(onCloseMock);
    await sleep(10);
    expect(onStdoutMock).toHaveBeenCalledWith("Hello, world!");
    expect(onStderrMock).not.toHaveBeenCalled();
    expect(onErrorMock).not.toHaveBeenCalled();
    expect(onCloseMock).toHaveBeenCalledWith(0);
  });

  it("can read and write a large message (>8KB) to a unix socket", async () => {
    const messages: string[] = [];
    await runtime.listenToUnixSocket((message) => {
      messages.push(message);
    });

    // Create a large message that exceeds typical socket buffer (>8KB)
    const largeData = {
      type: "claude",
      model: "test-model",
      prompt: "x".repeat(10000), // 10KB of data
      sessionId: "test-session",
    };

    await writeToUnixSocket({
      unixSocketPath: runtime.unixSocketPath,
      dataStr: JSON.stringify(largeData),
    });

    // Wait for message to be processed
    let retries = 0;
    const maxRetries = 20;
    while (messages.length === 0 && retries < maxRetries) {
      await sleep(50);
      retries++;
    }

    expect(messages.length).toBe(1);
    const receivedData = JSON.parse(messages[0]!);
    expect(receivedData.type).toBe("claude");
    expect(receivedData.model).toBe("test-model");
    expect(receivedData.prompt.length).toBe(10000);
    expect(receivedData.sessionId).toBe("test-session");
  });

  it("spawnCommandLine calls onClose only once even when multiple events fire", async () => {
    const onStdoutLineMock = vi.fn();
    const onStderrMock = vi.fn();
    const onErrorMock = vi.fn();
    const onCloseMock = vi.fn();

    runtime.spawnCommandLine("echo 'test' && exit 0", {
      onStdoutLine: onStdoutLineMock,
      onStderr: onStderrMock,
      onError: onErrorMock,
      onClose: onCloseMock,
      env: {},
    });

    // Wait for process to complete
    await sleep(200);

    // onClose should be called exactly once, not multiple times
    // (even though both 'exit' and 'close' events may fire)
    expect(onCloseMock).toHaveBeenCalledTimes(1);
    expect(onCloseMock).toHaveBeenCalledWith(0);
  });

  it("spawnCommand calls onClose only once even when multiple events fire", async () => {
    const onStdoutMock = vi.fn();
    const onStderrMock = vi.fn();
    const onErrorMock = vi.fn();
    const onCloseMock = vi.fn();

    runtime.spawnCommand("echo -n 'test' && exit 0", {
      onStdout: onStdoutMock,
      onStderr: onStderrMock,
      onError: onErrorMock,
      onClose: onCloseMock,
      env: {},
    });

    // Wait for process to complete
    await sleep(200);

    // onClose should be called exactly once
    expect(onCloseMock).toHaveBeenCalledTimes(1);
    expect(onCloseMock).toHaveBeenCalledWith(0);
  });

  it("spawnCommandLine detects process exit via polling fallback", async () => {
    const onStdoutLineMock = vi.fn();
    const onStderrMock = vi.fn();
    const onErrorMock = vi.fn();
    const onCloseMock = vi.fn();

    // Spawn a very short-lived process
    const pid = runtime.spawnCommandLine("exit 0", {
      onStdoutLine: onStdoutLineMock,
      onStderr: onStderrMock,
      onError: onErrorMock,
      onClose: onCloseMock,
      env: {},
    });

    expect(pid).toBeDefined();

    // Wait long enough for polling to detect the process is gone
    // (polling happens every 2 seconds, so wait 3 seconds to be safe)
    await sleep(3000);

    // Should have detected the process exit through either events or polling
    expect(onCloseMock).toHaveBeenCalledTimes(1);
  });
});

describe("runtime adapter operation contracts", () => {
  it("defines executable operation parity for codex, ACP, and legacy transports", () => {
    const matrix = [
      createDaemonRuntimeAdapterContract({ transportMode: "codex-app-server" }),
      createDaemonRuntimeAdapterContract({ transportMode: "acp" }),
      createDaemonRuntimeAdapterContract({ transportMode: "legacy" }),
    ];

    for (const contract of matrix) {
      expect(contract.operations.start.status).toBe("supported");
      expect(contract.operations.resume.status).toBe("supported");
      expect(contract.operations.stop.status).toBe("supported");
      expect(contract.operations.retry.status).toBe("supported");
      expect(contract.operations["event-normalization"].status).toBe(
        "supported",
      );
      expect(contract.operations["compact-and-retry"].status).toBe(
        "unsupported",
      );
      expect(contract.operations["human-intervention"].status).toBe(
        "unsupported",
      );
    }

    expect(matrix[0]?.session.previousResponseField).toBe(
      "codexPreviousResponseId",
    );
    expect(matrix[1]?.session.resolvedSessionField).toBe("acpSessionId");
    expect(matrix[2]?.session.resolvedSessionField).toBe("sessionId");
  });

  it("keeps web and daemon runtime adapter contracts in parity", () => {
    const pairs = [
      {
        web: codexRuntimeAdapterContract,
        daemon: createDaemonRuntimeAdapterContract({
          transportMode: "codex-app-server",
        }),
      },
      {
        web: claudeAcpRuntimeAdapterContract,
        daemon: createDaemonRuntimeAdapterContract({ transportMode: "acp" }),
      },
      {
        web: legacyRuntimeAdapterContract,
        daemon: createDaemonRuntimeAdapterContract({ transportMode: "legacy" }),
      },
    ];

    for (const { web, daemon } of pairs) {
      expect(daemon.adapterId).toBe(web.adapterId);
      expect(daemon.transportMode).toBe(web.transportMode);
      expect(daemon.protocolVersion).toBe(web.protocolVersion);
      expect(daemon.session).toEqual(web.session);
      expect(Object.keys(daemon.operations).sort()).toEqual(
        Object.keys(web.operations).sort(),
      );
      for (const operation of RuntimeAdapterOperationSchema.options) {
        expect(daemon.operations[operation]).toEqual(web.operations[operation]);
      }
    }
  });

  it("returns typed unsupported-operation results with clear recovery", () => {
    const contract = createDaemonRuntimeAdapterContract({
      transportMode: "codex-app-server",
    });

    const result = requireRuntimeAdapterOperation({
      contract,
      operation: "compact-and-retry",
    });

    expect(result).toEqual({
      status: "unsupported",
      operation: "compact-and-retry",
      reason:
        "Compaction is emitted as a typed recovery result before starting another Codex turn.",
      recovery: "retry-new-run",
    });
  });

  it("derives ACP resume from acpSessionId using the contract session field", () => {
    const contract = createDaemonRuntimeAdapterContract({
      transportMode: "acp",
    });

    expect(
      getRuntimeAdapterLifecycleOperation({
        contract,
        input: { sessionId: null, acpSessionId: "acp-session-1" },
      }),
    ).toBe("resume");
    expect(
      getRuntimeAdapterLifecycleOperation({
        contract,
        input: { sessionId: "legacy-session", acpSessionId: null },
      }),
    ).toBe("start");
  });

  it("enforces canonical daemon contracts instead of stale inbound contracts", () => {
    const staleInbound: RuntimeAdapterContract = {
      ...createDaemonRuntimeAdapterContract({ transportMode: "acp" }),
      adapterId: "legacy",
      transportMode: "legacy",
      protocolVersion: 1,
      session: {
        requestedSessionField: "sessionId",
        resolvedSessionField: "sessionId",
        previousResponseField: null,
      },
      operations: {
        ...createDaemonRuntimeAdapterContract({ transportMode: "acp" })
          .operations,
        "permission-response": {
          status: "unsupported",
          reason: "malicious stale contract",
          recovery: "manual-intervention",
        },
      },
    };

    const canonicalAcp = resolveDaemonRuntimeAdapterContract({
      transportMode: "acp",
      runtimeAdapterContract: staleInbound,
    });

    expect(canonicalAcp).toEqual(
      createDaemonRuntimeAdapterContract({ transportMode: "acp" }),
    );
    expect(
      hasRuntimeAdapterContractDrift({
        inbound: staleInbound,
        canonical: canonicalAcp,
      }),
    ).toBe(true);
    expect(
      getRuntimeAdapterLifecycleOperation({
        contract: canonicalAcp,
        input: { sessionId: null, acpSessionId: "acp-session-1" },
      }),
    ).toBe("resume");
    expect(
      requireRuntimeAdapterOperation({
        contract: canonicalAcp,
        operation: "permission-response",
      }),
    ).toEqual({ status: "ok" });

    const forgedLegacy = resolveDaemonRuntimeAdapterContract({
      transportMode: "legacy",
      runtimeAdapterContract: createDaemonRuntimeAdapterContract({
        transportMode: "acp",
      }),
    });

    expect(forgedLegacy).toEqual(
      createDaemonRuntimeAdapterContract({ transportMode: "legacy" }),
    );
    expect(
      requireRuntimeAdapterOperation({
        contract: forgedLegacy,
        operation: "permission-response",
      }),
    ).toMatchObject({
      status: "unsupported",
      operation: "permission-response",
    });

    const forgedCodex = resolveDaemonRuntimeAdapterContract({
      transportMode: "codex-app-server",
      runtimeAdapterContract: createDaemonRuntimeAdapterContract({
        transportMode: "acp",
      }),
    });

    expect(forgedCodex).toEqual(
      createDaemonRuntimeAdapterContract({ transportMode: "codex-app-server" }),
    );
    expect(
      getRuntimeAdapterLifecycleOperation({
        contract: forgedCodex,
        input: { sessionId: null, acpSessionId: "forged-acp-session" },
      }),
    ).toBe("start");
    expect(
      requireRuntimeAdapterOperation({
        contract: forgedCodex,
        operation: "permission-response",
      }),
    ).toMatchObject({
      status: "unsupported",
      operation: "permission-response",
    });
  });

  it("turns unsupported compact/restart/human recovery operations into UI-visible messages", () => {
    const contract = createDaemonRuntimeAdapterContract({
      transportMode: "codex-app-server",
    });

    for (const operation of [
      "compact-and-retry",
      "restart",
      "human-intervention",
    ] as const) {
      const result = requireRuntimeAdapterOperation({ contract, operation });
      expect(result.status).toBe("unsupported");
      if (result.status === "unsupported") {
        const message = runtimeAdapterUnsupportedOperationToMessage(result);
        expect(message.type).toBe("custom-error");
        if (message.type === "custom-error") {
          expect(message.error_info).toContain(operation);
          expect(message.error_info).toContain(`Recovery: ${result.recovery}`);
          expect(message.runtimeRecovery).toEqual({
            operation,
            reason: result.reason,
            recovery: result.recovery,
          });
        }
      }
    }
  });
});
