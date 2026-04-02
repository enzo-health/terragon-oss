/**
 * Container Source Fetcher
 *
 * Queries the actual sandbox container for execution truth.
 * Currently supports Docker. E2B and Daytona support to be added.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SourceSnapshot, ContainerState } from "../types.js";

const execFileAsync = promisify(execFile);

/** Sanitize container ID to prevent command injection */
export function sanitizeContainerId(id: string): string {
  // Only allow alphanumeric characters, hyphens, and underscores
  // Container IDs are typically hex strings or names with limited characters
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (sanitized !== id) {
    throw new Error(`Invalid container ID: contains unsafe characters`);
  }
  return sanitized;
}

/** Sanitize thread ID for use in container lookups */
export function sanitizeThreadId(id: string): string {
  // Thread IDs are UUIDs, allow alphanumeric and hyphens
  const sanitized = id.replace(/[^a-zA-Z0-9-]/g, "");
  if (sanitized !== id) {
    throw new Error(`Invalid thread ID: contains unsafe characters`);
  }
  return sanitized;
}

export interface ContainerConfig {
  timeoutMs: number;
}

export class ContainerSourceFetcher {
  private config: ContainerConfig;

  constructor(config: ContainerConfig) {
    this.config = config;
  }

  async fetchDockerContainer(
    sandboxId: string,
  ): Promise<SourceSnapshot<ContainerState>> {
    const startTime = Date.now();

    // Sanitize the sandbox ID to prevent command injection
    let safeSandboxId: string;
    try {
      safeSandboxId = sanitizeContainerId(sandboxId);
    } catch (error) {
      return {
        name: "container",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data: {
          provider: "docker",
          sandboxId: "invalid",
          status: "unknown",
          daemonRunning: false,
          daemonPid: null,
          lastLogTimestamp: null,
          workspacePath: "/root/repo",
          error: error instanceof Error ? error.message : "Invalid sandbox ID",
        },
      };
    }

    try {
      // Get container status using execFile (array args, no shell interpretation)
      const { stdout: inspectOutput } = await execFileAsync(
        "docker",
        ["inspect", safeSandboxId, "--format", "{{json .State}}"],
        { timeout: this.config.timeoutMs },
      );

      const containerState = JSON.parse(inspectOutput);

      // Check if daemon is running inside container
      let daemonRunning = false;
      let daemonPid: number | null = null;

      try {
        const { stdout: pidOutput } = await execFileAsync(
          "docker",
          ["exec", safeSandboxId, "pgrep", "-f", "node.*daemon"],
          { timeout: 5000 },
        );

        if (pidOutput.trim()) {
          daemonRunning = true;
          daemonPid = parseInt(pidOutput.trim(), 10);
        }
      } catch {
        // Daemon not running or container not accessible
      }

      // Get last log timestamp
      let lastLogTimestamp: string | null = null;
      try {
        const { stdout: logOutput } = await execFileAsync(
          "docker",
          ["logs", safeSandboxId, "--tail", "1", "--timestamps"],
          { timeout: 5000 },
        );

        if (logOutput.trim()) {
          // Parse timestamp from log line (format: 2026-03-29T18:00:00.123456789Z ...)
          const timestampMatch = logOutput.match(
            /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/,
          );
          if (timestampMatch) {
            lastLogTimestamp = timestampMatch[1] ?? null;
          }
        }
      } catch {
        // Logs not available
      }

      // Get git status inside container
      let gitStatus: ContainerState["gitStatus"] | undefined;
      try {
        const { stdout: branchOutput } = await execFileAsync(
          "docker",
          [
            "exec",
            safeSandboxId,
            "git",
            "-C",
            "/root/repo",
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
          ],
          { timeout: 5000 },
        );

        const { stdout: shaOutput } = await execFileAsync(
          "docker",
          [
            "exec",
            safeSandboxId,
            "git",
            "-C",
            "/root/repo",
            "rev-parse",
            "HEAD",
          ],
          { timeout: 5000 },
        );

        const { stdout: statusOutput } = await execFileAsync(
          "docker",
          [
            "exec",
            safeSandboxId,
            "git",
            "-C",
            "/root/repo",
            "status",
            "--porcelain",
          ],
          { timeout: 5000 },
        );

        const branch = branchOutput.trim();

        if (branch) {
          gitStatus = {
            branch,
            headSha: shaOutput.trim() || "unknown",
            hasUncommittedChanges: statusOutput.trim().length > 0,
          };
        }
      } catch {
        // Git not available or not a git repo
      }

      const data: ContainerState = {
        provider: "docker",
        sandboxId: safeSandboxId,
        status: this.mapDockerStatus(containerState.Status),
        daemonRunning,
        daemonPid,
        lastLogTimestamp,
        gitStatus,
        workspacePath: "/root/repo",
      };

      return {
        name: "container",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data,
      };
    } catch (error) {
      // Container might not exist or Docker not available
      return {
        name: "container",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data: {
          provider: "docker",
          sandboxId: safeSandboxId,
          status: "unknown",
          daemonRunning: false,
          daemonPid: null,
          lastLogTimestamp: null,
          workspacePath: "/root/repo",
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async findContainerForThread(threadId: string): Promise<string | null> {
    // Sanitize thread ID to prevent command injection
    let safeThreadId: string;
    try {
      safeThreadId = sanitizeThreadId(threadId);
    } catch {
      return null;
    }

    try {
      // Try to find container by label using execFile (array args, no shell)
      const { stdout } = await execFileAsync(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=threadId=${safeThreadId}`,
          "--format",
          "{{.ID}}",
        ],
        { timeout: 10000 },
      );

      if (stdout.trim()) {
        return stdout.trim().split("\n")[0] || null;
      }

      // Fallback: search by environment variable or process
      const { stdout: allContainers } = await execFileAsync(
        "docker",
        ["ps", "-a", "--format", "{{.ID}} {{.Names}} {{.Labels}}"],
        { timeout: 10000 },
      );

      // Look for containers with matching full thread ID in labels first.
      const lines = allContainers.trim().split("\n");
      for (const line of lines) {
        if (!line.includes(safeThreadId)) {
          continue;
        }
        const [id] = line.split(" ");
        if (id) {
          return id;
        }
      }

      // Fallback: look for containers with matching names (last 8 chars of thread ID)
      const threadSuffix = safeThreadId.slice(-8);
      for (const line of lines) {
        const parts = line.split(" ");
        const id = parts[0];
        const name = parts[1];
        if (name && name.includes(threadSuffix)) {
          return id || null;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  async fetchForThread(
    threadId: string,
    sandboxId?: string | null,
  ): Promise<SourceSnapshot<ContainerState>> {
    let sandboxLookupError: SourceSnapshot<ContainerState> | null = null;

    if (sandboxId) {
      const bySandboxId = await this.fetchDockerContainer(sandboxId);
      if (!bySandboxId.error) {
        return bySandboxId;
      }
      sandboxLookupError = bySandboxId;
    }

    const containerId = await this.findContainerForThread(threadId);

    if (!containerId) {
      if (sandboxLookupError) {
        return sandboxLookupError;
      }
      return {
        name: "container",
        fetchedAt: new Date(),
        durationMs: 0,
        data: {
          provider: "docker",
          sandboxId: "not-found",
          status: "unknown",
          daemonRunning: false,
          daemonPid: null,
          lastLogTimestamp: null,
          workspacePath: "/root/repo",
        },
        error: `No container found for thread ${threadId}`,
      };
    }

    return this.fetchDockerContainer(containerId);
  }

  private mapDockerStatus(dockerStatus: string): ContainerState["status"] {
    switch (dockerStatus) {
      case "running":
        return "running";
      case "paused":
        return "paused";
      case "exited":
      case "dead":
        return "exited";
      default:
        return "unknown";
    }
  }
}

export function createContainerFetcher(): ContainerSourceFetcher {
  return new ContainerSourceFetcher({
    timeoutMs: 15000,
  });
}
