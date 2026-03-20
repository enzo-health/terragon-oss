/**
 * Integration tests that spawn the real `codex` CLI binary.
 *
 * These tests require:
 *   - `codex` CLI installed and on PATH
 *   - Valid OpenAI credentials (~/.codex/auth.json or OPENAI_API_KEY)
 *
 * They are skipped automatically when `codex` is not available.
 * Run explicitly: pnpm -C packages/daemon test -- codex-app-server.integration
 */
import { spawn, execSync } from "node:child_process";
import { describe, expect, test, afterEach } from "vitest";
import {
  CodexAppServerManager,
  extractThreadEvent,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type JsonRpcNotificationEnvelope,
} from "./codex-app-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function codexAvailable(): boolean {
  try {
    execSync("codex --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const HAS_CODEX = codexAvailable();
const describeWithCodex = HAS_CODEX ? describe : describe.skip;

const realSpawn: CodexAppServerSpawn = (command, args, options) => {
  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.env,
  });
  return proc as unknown as CodexAppServerProcess;
};

type CapturedNotification = {
  method: string;
  params?: Record<string, unknown>;
};

function createRealManager() {
  const notifications: CapturedNotification[] = [];
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };

  const manager = new CodexAppServerManager({
    logger,
    model: "gpt-5.3-codex",
    daemonToken: null,
    env: process.env,
    requestTimeoutMs: 30_000,
    handshakeTimeoutMs: 30_000,
    spawnProcess: realSpawn,
  });

  manager.onNotification((notification: JsonRpcNotificationEnvelope) => {
    notifications.push({
      method: notification.method,
      params: notification.params,
    });
  });

  return { manager, notifications };
}

function waitForNotification(
  notifications: CapturedNotification[],
  predicate: (n: CapturedNotification) => boolean,
  timeoutMs: number,
): Promise<CapturedNotification> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const match = notifications.find(predicate);
      if (match) {
        clearInterval(interval);
        resolve(match);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        const methods = [...new Set(notifications.map((n) => n.method))].join(
          ", ",
        );
        reject(
          new Error(
            `Timed out waiting for notification (${timeoutMs}ms). Got: ${methods}`,
          ),
        );
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithCodex("codex app-server integration", () => {
  let activeManager: CodexAppServerManager | null = null;

  afterEach(async () => {
    if (activeManager) {
      await activeManager.kill();
      activeManager = null;
    }
  });

  test("handshake: spawns, initializes, and becomes ready", async () => {
    const { manager } = createRealManager();
    activeManager = manager;

    await manager.ensureReady();

    expect(manager.isAlive()).toBe(true);
  }, 30_000);

  test("full turn lifecycle: start thread, send prompt, receive agent response", async () => {
    const { manager, notifications } = createRealManager();
    activeManager = manager;

    await manager.ensureReady();

    // Start a thread
    const threadResult = (await manager.send({
      method: "thread/start",
      params: {
        model: "gpt-5.3-codex",
        stream: true,
        instructions:
          "You are a test bot. Reply with exactly one word: PONG. No other text.",
        sandbox: "read-only",
        approvalPolicy: "never",
      },
      threadChatId: "test-chat-1",
    })) as { thread?: { id?: string } };

    const threadId = threadResult?.thread?.id;
    expect(threadId).toBeDefined();
    expect(typeof threadId).toBe("string");

    // Wait briefly for MCP startup (may not fire if no servers configured)
    await waitForNotification(
      notifications,
      (n) => n.method === "codex/event/mcp_startup_complete",
      5_000,
    ).catch(() => {});

    // Send a turn
    await manager.send({
      method: "turn/start",
      params: {
        threadId,
        input: [{ type: "text", text: "Say PONG" }],
        sandboxPolicy: { type: "readOnly" },
      },
    });

    // Wait for turn to complete
    await waitForNotification(
      notifications,
      (n) =>
        n.method === "turn/completed" ||
        n.method === "codex/event/turn_completed" ||
        n.method === "turn/failed" ||
        n.method === "codex/event/turn_failed",
      60_000,
    );

    // Should have completed, not failed
    const failed = notifications.find(
      (n) =>
        n.method === "turn/failed" || n.method === "codex/event/turn_failed",
    );
    expect(failed).toBeUndefined();

    const completed = notifications.find(
      (n) =>
        n.method === "turn/completed" ||
        n.method === "codex/event/turn_completed",
    );
    expect(completed).toBeDefined();

    // Agent should have emitted item events
    const itemEvents = notifications.filter(
      (n) =>
        n.method === "item/completed" ||
        n.method === "codex/event/item_completed",
    );
    expect(itemEvents.length).toBeGreaterThan(0);
  }, 90_000);

  test("extractThreadEvent correctly normalizes real codex output", async () => {
    const { manager, notifications } = createRealManager();
    activeManager = manager;

    await manager.ensureReady();

    const threadResult = (await manager.send({
      method: "thread/start",
      params: {
        model: "gpt-5.3-codex",
        stream: true,
        instructions: "Reply PONG",
        sandbox: "read-only",
        approvalPolicy: "never",
      },
      threadChatId: "test-chat-2",
    })) as { thread?: { id?: string } };

    // Brief pause for MCP init
    await new Promise((r) => setTimeout(r, 3_000));

    await manager.send({
      method: "turn/start",
      params: {
        threadId: threadResult?.thread?.id,
        input: [{ type: "text", text: "PONG" }],
        sandboxPolicy: { type: "readOnly" },
      },
    });

    await waitForNotification(
      notifications,
      (n) =>
        n.method === "turn/completed" ||
        n.method === "codex/event/turn_completed",
      60_000,
    );

    // All notifications should survive extractThreadEvent without throwing
    const extractedTypes = new Set<string>();
    for (const n of notifications) {
      const extracted = extractThreadEvent(
        n as unknown as Record<string, unknown>,
      );
      if (extracted?.type) {
        extractedTypes.add(extracted.type);
      }
    }

    // Core event types from a real turn
    expect(extractedTypes.has("thread.started")).toBe(true);
    expect(extractedTypes.has("turn.started")).toBe(true);
    expect(extractedTypes.has("turn.completed")).toBe(true);
    expect(extractedTypes.has("item.completed")).toBe(true);
  }, 90_000);
});
