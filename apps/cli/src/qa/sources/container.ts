/**
 * Container Source Fetcher
 *
 * Queries the actual sandbox container for execution truth.
 * Currently supports Docker. E2B and Daytona support to be added.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { SourceSnapshot, ContainerState } from "../types.js";

const execAsync = promisify(exec);

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

    try {
      // Get container status
      const { stdout: inspectOutput } = await execAsync(
        `docker inspect ${sandboxId} --format '{{json .State}}'`,
        { timeout: this.config.timeoutMs },
      );

      const containerState = JSON.parse(inspectOutput);

      // Check if daemon is running inside container
      let daemonRunning = false;
      let daemonPid: number | null = null;

      try {
        const { stdout: pidOutput } = await execAsync(
          `docker exec ${sandboxId} pgrep -f "node.*daemon" || true`,
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
        const { stdout: logOutput } = await execAsync(
          `docker logs ${sandboxId} --tail 1 --timestamps 2>/dev/null || true`,
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
        const { stdout: branchOutput } = await execAsync(
          `docker exec ${sandboxId} git -C /root/repo rev-parse --abbrev-ref HEAD 2>/dev/null || true`,
          { timeout: 5000 },
        );

        const { stdout: shaOutput } = await execAsync(
          `docker exec ${sandboxId} git -C /root/repo rev-parse HEAD 2>/dev/null || true`,
          { timeout: 5000 },
        );

        const { stdout: statusOutput } = await execAsync(
          `docker exec ${sandboxId} git -C /root/repo status --porcelain 2>/dev/null || true`,
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
        sandboxId,
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
          sandboxId,
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
    try {
      // Try to find container by label or name pattern
      const { stdout } = await execAsync(
        `docker ps -a --filter "label=threadId=${threadId}" --format '{{.ID}}'`,
        { timeout: 10000 },
      );

      if (stdout.trim()) {
        return stdout.trim().split("\n")[0] || null;
      }

      // Fallback: search by environment variable or process
      const { stdout: allContainers } = await execAsync(
        `docker ps -a --format '{{.ID}} {{.Names}} {{.Status}}'`,
        { timeout: 10000 },
      );

      // Look for containers with matching names
      const lines = allContainers.trim().split("\n");
      for (const line of lines) {
        const parts = line.split(" ");
        const id = parts[0];
        const name = parts[1];
        if (name && name.includes(threadId.slice(-8))) {
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
  ): Promise<SourceSnapshot<ContainerState>> {
    const containerId = await this.findContainerForThread(threadId);

    if (!containerId) {
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
