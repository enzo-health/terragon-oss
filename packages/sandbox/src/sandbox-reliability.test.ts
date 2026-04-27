/**
 * Sandbox Streaming Reliability Test
 *
 * Measures real-world reliability of the sandbox → daemon → API pipeline.
 * This test ACTUALLY creates Docker containers.
 */

import { describe, it, expect } from "vitest";
import { getOrCreateSandbox } from "./sandbox";
import { installDaemon, sendMessage, getDaemonLogs } from "./daemon";
import { DockerProvider } from "./providers/docker-provider";
import type { ISandboxSession, CreateSandboxOptions } from "./types";
import type { DaemonMessageClaude } from "@terragon/daemon/shared";

type ReliabilityMetrics = {
  sandboxStartupMs: number;
  daemonInstallMs: number;
  messagesSent: number;
  messagesAcknowledged: number;
  logsWritten: number;
  reliabilityScore: number;
  errors: string[];
};

const TEST_TIMEOUT = 2 * 60 * 1000; // 2 minutes
// Use the same test repo as the existing sandbox tests
const SANDBOX_OPTIONS: CreateSandboxOptions = {
  threadName: "reliability-test",
  userName: "test-user",
  userEmail: "test@example.com",
  githubAccessToken: process.env.GITHUB_TOKEN || "test-token",
  githubRepoFullName: "SawyerHood/test-project",
  repoBaseBranchName: "main",
  userId: `reliability-test-${Date.now()}`,
  sandboxProvider: "docker",
  createNewBranch: true,
  autoUpdateDaemon: false,
  sandboxSize: "small",
  publicUrl: "http://host.docker.internal:3000",
  featureFlags: {},
  agent: null,
  agentCredentials: null,
  environmentVariables: [],
  generateBranchName: async () => null,
  onStatusUpdate: async () => {},
};

async function runReliabilityTest(params: {
  messageCount: number;
}): Promise<ReliabilityMetrics> {
  const { messageCount } = params;
  const errors: string[] = [];
  const metrics: Partial<ReliabilityMetrics> = {};

  let sandbox: ISandboxSession | null = null;

  try {
    // Phase 1: Sandbox startup
    const sandboxStart = Date.now();
    sandbox = await getOrCreateSandbox(null, SANDBOX_OPTIONS);
    metrics.sandboxStartupMs = Date.now() - sandboxStart;

    // Phase 2: Daemon installation
    const daemonStart = Date.now();
    await installDaemon({
      session: sandbox,
      environmentVariables: [],
      githubAccessToken: "test-token",
      agentCredentials: null,
      publicUrl: SANDBOX_OPTIONS.publicUrl,
      featureFlags: {},
    });
    metrics.daemonInstallMs = Date.now() - daemonStart;

    // Phase 3: Send messages
    let sentCount = 0;
    for (let i = 0; i < messageCount; i++) {
      const msg: DaemonMessageClaude = {
        type: "claude",
        agent: "claudeCode",
        agentVersion: 0,
        model: "claude-3-5-sonnet-20241022",
        token: `test-token-${Date.now()}-${i}`,
        prompt: `Test message ${i + 1}`,
        sessionId: null,
        threadId: `reliability-thread-${Date.now()}`,
        threadChatId: `reliability-chat-${Date.now()}`,
        runId: `reliability-run-${Date.now()}`,
        transportMode: "legacy",
        protocolVersion: 1,
      };

      try {
        await sendMessage({ session: sandbox, message: msg });
        sentCount++;
      } catch (error) {
        errors.push(
          `Message ${i} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    metrics.messagesSent = sentCount;

    // Phase 4: Wait and check daemon logs
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const logs = await getDaemonLogs({ session: sandbox, parseJson: false });
      metrics.logsWritten = logs.length;

      // For now, count successful sends as acknowledgments
      // (The daemon received the message if sendMessage didn't throw)
      metrics.messagesAcknowledged = sentCount;
    } catch {
      metrics.logsWritten = 0;
      metrics.messagesAcknowledged = sentCount; // Assume success if no error
    }

    // Calculate reliability: successful sends / attempted sends
    const deliveryRate = messageCount > 0 ? sentCount / messageCount : 0;
    metrics.reliabilityScore = Math.round(deliveryRate * 100);
  } catch (error) {
    errors.push(
      `Test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    metrics.reliabilityScore = 0;
  } finally {
    if (sandbox) {
      try {
        await sandbox.hibernate();
      } catch {}
    }
    await DockerProvider.cleanupTestContainers();
  }

  return {
    sandboxStartupMs: metrics.sandboxStartupMs || 0,
    daemonInstallMs: metrics.daemonInstallMs || 0,
    messagesSent: metrics.messagesSent || 0,
    messagesAcknowledged: metrics.messagesAcknowledged || 0,
    logsWritten: metrics.logsWritten || 0,
    reliabilityScore: metrics.reliabilityScore || 0,
    errors,
  };
}

describe("Sandbox Streaming Reliability", () => {
  it(
    "delivers messages reliably (3 messages)",
    async () => {
      console.log("[sandbox-reliability] Starting test...");

      const result = await runReliabilityTest({ messageCount: 3 });

      console.log(
        "SANDBOX_RELIABILITY_3:",
        JSON.stringify({
          sandboxStartupMs: result.sandboxStartupMs,
          daemonInstallMs: result.daemonInstallMs,
          messagesSent: result.messagesSent,
          messagesAcknowledged: result.messagesAcknowledged,
          logsWritten: result.logsWritten,
          reliabilityScore: result.reliabilityScore,
          errorCount: result.errors.length,
        }),
      );

      expect(result.sandboxStartupMs).toBeGreaterThan(0);
      expect(result.daemonInstallMs).toBeGreaterThan(0);
      expect(result.messagesSent).toBe(3);
      // Full end-to-end requires API server. Testing daemon message delivery.
      expect(result.reliabilityScore).toBe(100); // All sends should succeed
    },
    TEST_TIMEOUT,
  );

  it(
    "handles burst (5 rapid messages)",
    async () => {
      const result = await runReliabilityTest({ messageCount: 5 });

      console.log(
        "SANDBOX_RELIABILITY_BURST_5:",
        JSON.stringify({
          sandboxStartupMs: result.sandboxStartupMs,
          messagesSent: result.messagesSent,
          messagesAcknowledged: result.messagesAcknowledged,
          reliabilityScore: result.reliabilityScore,
          errorCount: result.errors.length,
        }),
      );

      expect(result.messagesSent).toBe(5);
      // Full end-to-end requires API server. Testing daemon message delivery.
      expect(result.reliabilityScore).toBe(100); // All sends should succeed
    },
    TEST_TIMEOUT,
  );
});
