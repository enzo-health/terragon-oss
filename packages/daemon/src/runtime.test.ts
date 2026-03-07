import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  DaemonRuntime,
  writeToUnixSocket,
  parseSdlcSelfDispatchPayload,
} from "./runtime";
import { nanoid } from "nanoid/non-secure";
import fs from "node:fs";

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

describe("parseSdlcSelfDispatchPayload", () => {
  const validPayload = {
    selfDispatch: {
      token: "tok",
      prompt: "do stuff",
      runId: "run-1",
      threadId: "t-1",
      threadChatId: "tc-1",
      tokenNonce: "nonce",
      model: "claude-4",
      agent: "claude-code",
      agentVersion: 1,
      protocolVersion: 2,
      transportMode: "legacy",
      permissionMode: "allowAll",
      sessionId: null as string | null,
      featureFlags: { sdlcDaemonSelfDispatch: true },
    },
  };

  it("returns null for null/undefined/non-object body", () => {
    expect(parseSdlcSelfDispatchPayload(null)).toBeNull();
    expect(parseSdlcSelfDispatchPayload(undefined)).toBeNull();
    expect(parseSdlcSelfDispatchPayload("string")).toBeNull();
    expect(parseSdlcSelfDispatchPayload(42)).toBeNull();
  });

  it("returns null when selfDispatch is missing or not an object", () => {
    expect(parseSdlcSelfDispatchPayload({})).toBeNull();
    expect(parseSdlcSelfDispatchPayload({ selfDispatch: null })).toBeNull();
    expect(parseSdlcSelfDispatchPayload({ selfDispatch: "bad" })).toBeNull();
    expect(parseSdlcSelfDispatchPayload({ selfDispatch: 123 })).toBeNull();
  });

  it("returns null when required string fields are missing", () => {
    const requiredStrings = [
      "token",
      "prompt",
      "runId",
      "threadId",
      "threadChatId",
      "tokenNonce",
      "model",
      "agent",
      "transportMode",
      "permissionMode",
    ];
    for (const field of requiredStrings) {
      const bad = structuredClone(validPayload);
      delete (bad.selfDispatch as Record<string, unknown>)[field];
      expect(parseSdlcSelfDispatchPayload(bad)).toBeNull();
    }
  });

  it("returns null when number fields are wrong type", () => {
    for (const field of ["agentVersion", "protocolVersion"]) {
      const bad = structuredClone(validPayload);
      (bad.selfDispatch as Record<string, unknown>)[field] = "not-a-number";
      expect(parseSdlcSelfDispatchPayload(bad)).toBeNull();
    }
  });

  it("returns null when featureFlags is null or not an object", () => {
    const bad1 = structuredClone(validPayload);
    (bad1.selfDispatch as Record<string, unknown>).featureFlags = null;
    expect(parseSdlcSelfDispatchPayload(bad1)).toBeNull();

    const bad2 = structuredClone(validPayload);
    (bad2.selfDispatch as Record<string, unknown>).featureFlags = "bad";
    expect(parseSdlcSelfDispatchPayload(bad2)).toBeNull();
  });

  it("returns null when sessionId is not string or null", () => {
    const bad = structuredClone(validPayload);
    (bad.selfDispatch as Record<string, unknown>).sessionId = 123;
    expect(parseSdlcSelfDispatchPayload(bad)).toBeNull();
  });

  it("returns valid payload with sessionId: null", () => {
    const result = parseSdlcSelfDispatchPayload(validPayload);
    expect(result).toEqual(validPayload.selfDispatch);
  });

  it("returns valid payload with sessionId as string", () => {
    const withSession = structuredClone(validPayload);
    withSession.selfDispatch.sessionId = "sess-1";
    const result = parseSdlcSelfDispatchPayload(withSession);
    expect(result).toEqual(withSession.selfDispatch);
  });
});
