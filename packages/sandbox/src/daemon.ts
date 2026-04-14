import { AIAgentCredentials } from "@terragon/agent/types";
import {
  DaemonMessage,
  defaultPipePath,
  FeatureFlags,
} from "@terragon/daemon/shared";
import { createHash } from "crypto";
import { getDaemonFile, getMcpServerFile } from "./constants";
import { getEnv } from "./env";
import { McpConfig } from "./mcp-config";
import { CreateSandboxOptions, ISandboxSession } from "./types";
import { buildMergedMcpConfig } from "./utils/mcp-merge";

export const DAEMON_FILE_PATH = "/tmp/terragon-daemon.mjs";
export const MCP_SERVER_FILE_PATH = "/tmp/terry-mcp-server.mjs";
export const MCP_SERVER_JSON_FILE_PATH = "/tmp/mcp-server.json";
export const DAEMON_LOG_FILE_PATH = "/tmp/terragon-daemon.log";
const DAEMON_SEND_MAX_ATTEMPTS = 4;
const DAEMON_SEND_BASE_BACKOFF_MS = 150;
const DAEMON_SEND_TIMEOUT_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRetryBackoffMs(attempt: number): number {
  const cappedAttempt = Math.min(Math.max(attempt, 0), 6);
  const expBackoff = DAEMON_SEND_BASE_BACKOFF_MS * 2 ** cappedAttempt;
  const jitter = Math.floor(Math.random() * 50);
  return expBackoff + jitter;
}

function isTransientDaemonSendError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message.toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("closed before ack") ||
    msg.includes("not ready") ||
    msg.includes("enoent") ||
    msg.includes("no such file") ||
    msg.includes("socket") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("broken pipe")
  );
}

async function startDaemon({
  session,
  environmentVariables,
  githubAccessToken,
  agentCredentials,
  publicUrl,
  featureFlags,
}: {
  session: ISandboxSession;
  environmentVariables: Array<{ key: string; value: string }>;
  githubAccessToken: string;
  agentCredentials: AIAgentCredentials | null;
  publicUrl: string;
  featureFlags: FeatureFlags;
}) {
  if (!agentCredentials) {
    console.warn("No agent credentials provided");
  }
  await session.runBackgroundCommand(
    [
      "node",
      DAEMON_FILE_PATH,
      "--output-format",
      "json",
      "-u",
      publicUrl,
      "--mcp-config-path",
      MCP_SERVER_JSON_FILE_PATH,
      // Append stdout and stderr to the log file
      `>> ${DAEMON_LOG_FILE_PATH} 2>&1`,
    ].join(" "),
    {
      env: getEnv({
        userEnv: environmentVariables,
        githubAccessToken,
        agentCredentials,
        overrides: {
          // 1 minute max timeout for bash commands
          BASH_MAX_TIMEOUT_MS: (60 * 1000).toString(),
          // Pass feature flags as JSON in environment variable
          TERRAGON_FEATURE_FLAGS: JSON.stringify(featureFlags),
        },
      }),
      onOutput: (data) => {
        console.log(data);
      },
    },
  );
}

export async function installDaemon({
  session,
  environmentVariables,
  githubAccessToken,
  agentCredentials,
  userMcpConfig,
  publicUrl,
  featureFlags,
}: {
  session: ISandboxSession;
  environmentVariables: Array<{ key: string; value: string }>;
  githubAccessToken: string;
  agentCredentials: AIAgentCredentials | null;
  userMcpConfig?: McpConfig;
  publicUrl: string;
  featureFlags: FeatureFlags;
}) {
  const daemonFile = getDaemonFile();
  const mcpServerFile = getMcpServerFile();

  await session.writeTextFile(DAEMON_FILE_PATH, daemonFile);
  await session.writeTextFile(MCP_SERVER_FILE_PATH, mcpServerFile);

  // Merge user MCP config with built-in terry server (shared logic with Codex)
  const mcpConfig = buildMergedMcpConfig({
    userMcpConfig,
    includeTerry: true,
    terryCommand: "node",
    terryArgs: [MCP_SERVER_FILE_PATH],
  });

  await session.writeTextFile(
    MCP_SERVER_JSON_FILE_PATH,
    JSON.stringify(mcpConfig, null, 2),
  );
  await session.runCommand(`chmod +x ${DAEMON_FILE_PATH}`);
  console.log("Daemon file written");
  await startDaemon({
    session,
    environmentVariables,
    githubAccessToken,
    agentCredentials,
    publicUrl,
    featureFlags,
  });
  console.log("Daemon command running");
  await waitForDaemonReady(session);
}

async function waitForDaemonReady(session: ISandboxSession, maxAttempts = 20) {
  let lastError: Error | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await sendPingMessage({ session });
      if (result) {
        console.log("Daemon is ready");
        await new Promise((resolve) => setTimeout(resolve, 100));
        return;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    const delay = Math.min(100 * Math.pow(2, i), 1000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(
    `Daemon failed to start within timeout period. Last error: ${lastError?.message || "unknown"}. Check /tmp/terragon-daemon.log for details.`,
  );
}

export async function getDaemonLogs({
  session,
  parseJson = true,
}: {
  session: ISandboxSession;
  parseJson?: boolean;
}) {
  const rawLogs = await session.readTextFile(DAEMON_LOG_FILE_PATH);
  return rawLogs
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (parseJson) {
        try {
          return JSON.parse(line);
        } catch (e) {
          return line;
        }
      } else {
        return line;
      }
    });
}

export async function updateDaemonIfOutdated({
  session,
  options,
}: {
  session: ISandboxSession;
  options: CreateSandboxOptions;
}) {
  try {
    // Get the current daemon file content
    const newDaemonHash = createHash("sha256")
      .update(getDaemonFile())
      .digest("hex");
    // Check if daemon file exists and get its hash
    const hashCheckCommand = `if [ -f ${DAEMON_FILE_PATH} ]; then sha256sum ${DAEMON_FILE_PATH} | cut -d' ' -f1; else echo "NO_FILE"; fi`;
    const existingHash = (await session.runCommand(hashCheckCommand)).trim();

    // If file doesn't exist or hash differs, update the daemon
    if (existingHash === "NO_FILE" || existingHash !== newDaemonHash) {
      console.log(
        `Daemon update needed: existing hash=${existingHash}, new hash=${newDaemonHash}`,
      );
      await sendKillMessage({ session });
      // Force-kill any remaining daemon processes before installing the update
      await forceKillAllDaemonProcesses({ session });
      // Remove the old daemon files
      await session.runCommand(
        `rm -f ${DAEMON_FILE_PATH} ${MCP_SERVER_FILE_PATH} ${MCP_SERVER_JSON_FILE_PATH} ${defaultPipePath}`,
      );
      // Install the new daemon
      await installDaemon({
        session,
        environmentVariables: options.environmentVariables,
        githubAccessToken: options.githubAccessToken,
        agentCredentials: options.agentCredentials,
        userMcpConfig: options.mcpConfig,
        publicUrl: options.publicUrl,
        featureFlags: options.featureFlags,
      });
      console.log("Daemon updated successfully");
    } else {
      console.log("Daemon is up-to-date");
    }
  } catch (error) {
    // Don't throw - we don't want to fail sandbox resumption if update fails
    console.error("Error checking/updating daemon:", error);
  }
}

export async function restartDaemonIfNotRunning({
  session,
  options,
}: {
  session: ISandboxSession;
  options: CreateSandboxOptions;
}) {
  if (await sendPingMessage({ session })) {
    console.log("Daemon is already running");
    return;
  }
  console.log("Daemon is not ready/running, restarting it...");

  // Check if daemon binary exists — if missing (sandbox recreated), reinstall
  const daemonExists = (
    await session.runCommand(
      `test -f ${DAEMON_FILE_PATH} && echo "exists" || echo "missing"`,
    )
  ).trim();

  if (daemonExists === "missing") {
    console.log("Daemon binary missing, reinstalling...");
    await installDaemon({
      session,
      environmentVariables: options.environmentVariables || [],
      githubAccessToken: options.githubAccessToken,
      agentCredentials: options.agentCredentials,
      userMcpConfig: options.mcpConfig,
      publicUrl: options.publicUrl,
      featureFlags: options.featureFlags,
    });
    return;
  }

  console.log("Killing existing daemon");
  await sendKillMessage({ session });
  // Force-kill any remaining daemon processes to prevent accumulation across
  // delivery-loop retries (graceful kill may silently fail when daemon is stuck)
  await forceKillAllDaemonProcesses({ session });
  console.log("Starting daemon");
  await startDaemon({
    session,
    environmentVariables: options.environmentVariables || [],
    githubAccessToken: options.githubAccessToken,
    agentCredentials: options.agentCredentials,
    publicUrl: options.publicUrl,
    featureFlags: options.featureFlags,
  });
  console.log("Daemon started, waiting for it to be ready");
  await waitForDaemonReady(session);
}

export async function sendMessage({
  session,
  message,
}: {
  session: ISandboxSession;
  message: DaemonMessage;
}) {
  const jsonMessage = JSON.stringify(message);
  const messageHash = createHash("sha256")
    .update(jsonMessage)
    .digest("hex")
    .slice(0, 12);
  const messageFilePath = `/tmp/terragon-daemon-message-${Date.now()}-${messageHash}.json`;

  console.log("[daemon-send] sending message", {
    messageHash,
    attempt: 1,
    totalAttempts: DAEMON_SEND_MAX_ATTEMPTS,
  });

  await session.writeTextFile(messageFilePath, jsonMessage);
  try {
    for (let attempt = 0; attempt < DAEMON_SEND_MAX_ATTEMPTS; attempt++) {
      try {
        await session.runCommand(
          `node ${DAEMON_FILE_PATH} --write < ${messageFilePath}`,
          { timeoutMs: DAEMON_SEND_TIMEOUT_MS, cwd: "/" },
        );
        console.log("Message sent to daemon", { attempt: attempt + 1 });
        return;
      } catch (error) {
        const isLastAttempt = attempt === DAEMON_SEND_MAX_ATTEMPTS - 1;
        const transient = isTransientDaemonSendError(error);
        if (!transient || isLastAttempt) {
          console.error("[daemon-send] all retries exhausted", {
            messageHash,
            attempts: DAEMON_SEND_MAX_ATTEMPTS,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
        const waitMs = computeRetryBackoffMs(attempt);
        console.warn("Transient daemon send failure, retrying", {
          attempt: attempt + 1,
          waitMs,
          error,
        });
        await sleep(waitMs);
      }
    }
  } finally {
    try {
      await session.runCommand(`rm -f ${messageFilePath}`, { cwd: "/" });
    } catch (cleanupError) {
      console.warn("Failed to clean up daemon message temp file", {
        messageFilePath,
        cleanupError,
      });
    }
  }
}

export async function sendPingMessage({
  session,
}: {
  session: ISandboxSession;
}): Promise<boolean> {
  try {
    await sendMessage({ session, message: { type: "ping" } });
    return true;
  } catch {
    return false;
  }
}

async function sendKillMessage({ session }: { session: ISandboxSession }) {
  try {
    // Send a kill message to the daemon
    await sendMessage({ session, message: { type: "kill" } });
    // Wait a bit for process to terminate
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    // Ignore errors during kill
    console.error("Error killing existing daemon", { error });
  }
}

/**
 * Force-kill ALL terragon-daemon.mjs processes running in the sandbox using
 * pkill. This is a safety net that runs after the graceful `sendKillMessage`
 * attempt to prevent daemon process accumulation across delivery-loop retries.
 *
 * We use `|| true` so the command exits 0 even when pkill finds no processes
 * (exit code 1 would cause session.runCommand to throw in some providers).
 */
async function forceKillAllDaemonProcesses({
  session,
}: {
  session: ISandboxSession;
}) {
  try {
    // First pass: SIGTERM with a short grace window so well-behaved daemons
    // can shut down cleanly (release sockets, flush buffers).
    await session.runCommand(`pkill -TERM -f terragon-daemon.mjs || true`, {
      cwd: "/",
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // Second pass: SIGKILL anything still running. If the daemon is wedged
    // (the actual root cause of the multi-daemon accumulation we're fixing),
    // SIGTERM alone won't unblock the new daemon spawn; SIGKILL guarantees
    // the slot is free.
    await session.runCommand(`pkill -KILL -f terragon-daemon.mjs || true`, {
      cwd: "/",
    });
    // Brief wait so the kernel finishes reaping before we start the new daemon
    await new Promise((resolve) => setTimeout(resolve, 200));
  } catch (error) {
    // Non-fatal: best-effort cleanup; log and continue
    console.warn("forceKillAllDaemonProcesses: pkill failed (non-fatal)", {
      error,
    });
  }
}
