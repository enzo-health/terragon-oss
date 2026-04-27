/**
 * Real Sandbox E2E Reliability Test
 *
 * This test ACTUALLY spins up Docker sandboxes and measures the full pipeline:
 *   Test → Docker Sandbox → Daemon → Agent (mock) → Stream → API
 *
 * This is the real deal - no mocks, actual infrastructure.
 */

import type { DaemonMessageClaude } from "@terragon/daemon/shared";
import { getOrCreateSandbox } from "@terragon/sandbox";
import {
  getDaemonLogs,
  installDaemon,
  sendMessage,
} from "@terragon/sandbox/daemon";
import type {
  CreateSandboxOptions,
  ISandboxSession,
} from "@terragon/sandbox/types";
import { describe, expect, it } from "vitest";

// Test timeout: 3 minutes for sandbox startup + test
type ReliabilityMetrics = {
  sandboxStartupMs: number;
  daemonReadyMs: number;
  messagesSent: number;
  messagesFlushed: number;
  messagesInLog: number;
  flushLatencyMs: number;
  reliabilityScore: number;
  errors: string[];
};

const TEST_TIMEOUT = 3 * 60 * 1000;
const SANDBOX_OPTIONS: CreateSandboxOptions = {
  threadName: "e2e-reliability-test",
  userName: "test-user",
  userEmail: "test@example.com",
  githubAccessToken: "test-token",
  githubRepoFullName: "test/repo",
  repoBaseBranchName: "main",
  userId: `test-user-${Date.now()}`,
  sandboxProvider: "docker",
  createNewBranch: true,
  autoUpdateDaemon: false,
  sandboxSize: "small",
  publicUrl: "http://host.docker.internal:3000",
  featureFlags: {},
  agent: null,
  agentCredentials: null,
  environmentVariables: [{ key: "TEST_VAR", value: "test_value" }],
  generateBranchName: async () => null,
  onStatusUpdate: async () => {},
};

async function runSandboxReliabilityTest(params: {
  messageCount: number;
  messageIntervalMs: number;
}): Promise<ReliabilityMetrics> {
  const { messageCount, messageIntervalMs } = params;
  const errors: string[] = [];
  const metrics: Partial<ReliabilityMetrics> = {};

  let sandbox: ISandboxSession | null = null;

  try {
    // Phase 1: Sandbox startup
    const sandboxStart = Date.now();
    console.log("[e2e] Creating sandbox...");
    sandbox = await getOrCreateSandbox(null, SANDBOX_OPTIONS);
    metrics.sandboxStartupMs = Date.now() - sandboxStart;
    console.log(
      `[e2e] Sandbox created: ${sandbox.sandboxId} (${metrics.sandboxStartupMs}ms)`,
    );

    // Phase 2: Daemon installation and startup
    const daemonStart = Date.now();
    console.log("[e2e] Installing daemon...");
    await installDaemon({
      session: sandbox,
      environmentVariables: SANDBOX_OPTIONS.environmentVariables || [],
      githubAccessToken: SANDBOX_OPTIONS.githubAccessToken,
      agentCredentials: null,
      publicUrl: SANDBOX_OPTIONS.publicUrl,
      featureFlags: SANDBOX_OPTIONS.featureFlags || {},
    });
    metrics.daemonReadyMs = Date.now() - daemonStart;
    console.log(`[e2e] Daemon ready (${metrics.daemonReadyMs}ms)`);

    // Phase 3: Send messages to daemon
    const messages: DaemonMessageClaude[] = [];
    for (let i = 0; i < messageCount; i++) {
      const msg: DaemonMessageClaude = {
        type: "claude",
        agent: "claudeCode",
        agentVersion: 0,
        model: "claude-3-5-sonnet-20241022",
        token: `test-token-${Date.now()}`,
        prompt: `Test message ${i + 1} of ${messageCount}`,
        sessionId: null,
        threadId: `test-thread-${Date.now()}`,
        threadChatId: `test-chat-${Date.now()}`,
        runId: `test-run-${Date.now()}`,
        transportMode: "legacy",
        protocolVersion: 1,
      };
      messages.push(msg);
    }

    let sentCount = 0;
    for (const msg of messages) {
      try {
        await sendMessage({ session: sandbox, message: msg });
        sentCount++;
        if (messageIntervalMs > 0) {
          await new Promise((r) => setTimeout(r, messageIntervalMs));
        }
      } catch (error) {
        errors.push(
          `Failed to send message ${sentCount}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    metrics.messagesSent = sentCount;
    console.log(`[e2e] Sent ${sentCount}/${messageCount} messages`);

    // Phase 4: Wait for daemon to flush and collect logs
    await new Promise((r) => setTimeout(r, 3000)); // Give daemon time to flush

    const flushStart = Date.now();
    let flushWaited = 0;
    const maxFlushWait = 10000;
    let lastLogCount = 0;
    let stableCount = 0;

    while (flushWaited < maxFlushWait) {
      await new Promise((r) => setTimeout(r, 500));
      flushWaited += 500;

      try {
        const logs = await getDaemonLogs({
          session: sandbox,
          parseJson: false,
        });
        const logCount = logs.length;

        // Check if log count stabilized (no new entries)
        if (logCount === lastLogCount) {
          stableCount++;
          if (stableCount >= 3) {
            break; // Logs stable for 1.5s, assume flush complete
          }
        } else {
          stableCount = 0;
          lastLogCount = logCount;
        }
      } catch {
        // Ignore log read errors
      }
    }

    metrics.flushLatencyMs = Date.now() - flushStart;
    metrics.messagesInLog = lastLogCount;

    // Phase 5: Analyze logs for flush evidence
    try {
      const logs = await getDaemonLogs({ session: sandbox, parseJson: true });
      const flushEvents = logs.filter(
        (l) =>
          typeof l === "object" &&
          l &&
          "Sending messages to API" in (l as object),
      );
      metrics.messagesFlushed = flushEvents.length;
    } catch {
      metrics.messagesFlushed = 0;
    }

    // Calculate reliability
    const deliveryRate =
      metrics.messagesSent > 0
        ? (metrics.messagesFlushed || 0) / metrics.messagesSent
        : 0;
    metrics.reliabilityScore = Math.round(deliveryRate * 100);
  } catch (error) {
    errors.push(
      `Test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    metrics.reliabilityScore = 0;
  } finally {
    // Cleanup - just hibernate the sandbox, don't force kill containers
    // The test containers will be cleaned up by the test framework
    if (sandbox) {
      try {
        await sandbox.hibernate();
      } catch {}
    }
  }

  return {
    sandboxStartupMs: metrics.sandboxStartupMs || 0,
    daemonReadyMs: metrics.daemonReadyMs || 0,
    messagesSent: metrics.messagesSent || 0,
    messagesFlushed: metrics.messagesFlushed || 0,
    messagesInLog: metrics.messagesInLog || 0,
    flushLatencyMs: metrics.flushLatencyMs || 0,
    reliabilityScore: metrics.reliabilityScore || 0,
    errors,
  };
}

describe("E2E Sandbox Reliability", () => {
  it(
    "spins up sandbox and delivers messages (5 messages)",
    async () => {
      console.log("[e2e] Starting sandbox reliability test...");

      const result = await runSandboxReliabilityTest({
        messageCount: 5,
        messageIntervalMs: 100,
      });

      console.log(
        "SANDBOX_RELIABILITY_RESULT_5:",
        JSON.stringify({
          sandboxStartupMs: result.sandboxStartupMs,
          daemonReadyMs: result.daemonReadyMs,
          messagesSent: result.messagesSent,
          messagesFlushed: result.messagesFlushed,
          messagesInLog: result.messagesInLog,
          flushLatencyMs: result.flushLatencyMs,
          reliabilityScore: result.reliabilityScore,
          errorCount: result.errors.length,
        }),
      );

      // Assertions
      expect(result.sandboxStartupMs).toBeGreaterThan(0);
      expect(result.sandboxStartupMs).toBeLessThan(60000); // Under 60s
      expect(result.daemonReadyMs).toBeGreaterThan(0);
      expect(result.daemonReadyMs).toBeLessThan(30000); // Under 30s
      expect(result.messagesSent).toBe(5);
      expect(result.reliabilityScore).toBeGreaterThanOrEqual(80); // 80%+ delivery
      expect(result.errors).toHaveLength(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "handles message bursts (10 rapid messages)",
    async () => {
      const result = await runSandboxReliabilityTest({
        messageCount: 10,
        messageIntervalMs: 50, // 20 msg/sec
      });

      console.log(
        "SANDBOX_RELIABILITY_BURST_10:",
        JSON.stringify({
          sandboxStartupMs: result.sandboxStartupMs,
          messagesSent: result.messagesSent,
          messagesFlushed: result.messagesFlushed,
          flushLatencyMs: result.flushLatencyMs,
          reliabilityScore: result.reliabilityScore,
          messagesPerSecond: 10 / (result.flushLatencyMs / 1000),
          errorCount: result.errors.length,
        }),
      );

      expect(result.messagesSent).toBe(10);
      expect(result.reliabilityScore).toBeGreaterThanOrEqual(70); // Allow some loss under load
    },
    TEST_TIMEOUT,
  );
});
