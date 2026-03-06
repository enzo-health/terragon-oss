import {
  BackgroundCommandOptions,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { formatError } from "@terragon/utils/error";

const HOME_DIR = "/root";
const REPO_DIR = "/root/repo";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const BACKGROUND_COMMAND_START_TIMEOUT_MS = 10_000; // 10 seconds

const SANDBOX_IMAGE = "ghcr.io/terragon-labs/containers-test:latest";

// ---------------------------------------------------------------------------
// Callback interface (DB access injected from apps/www to avoid circular dep)
// ---------------------------------------------------------------------------

export interface WorkerInfo {
  id: string;
  hostname: string;
  port: number;
  apiKey: string; // already decrypted
}

/**
 * DB-backed callbacks injected by the caller (apps/www).
 * The sandbox package cannot import @terragon/shared directly because
 * @terragon/shared imports from @terragon/sandbox/types (cyclic dependency).
 */
export interface OpenSandboxCallbacks {
  /** Pick an available worker and atomically reserve it. Throws "No Mac Mini workers available" if none free. */
  allocateWorker(): Promise<WorkerInfo>;
  /** Look up a worker by its DB id. Returns null if not found. */
  getWorker(workerId: string): Promise<WorkerInfo | null>;
  /** Record a new sandbox allocation in the DB. */
  recordAllocation(workerId: string, containerId: string): Promise<void>;
  /** Delete the allocation row and decrement the worker's sandbox count. */
  releaseAllocation(containerId: string, workerId: string): Promise<void>;
  /** Mark an allocation as paused in the DB. */
  setAllocationPaused(containerId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOpenSandboxId(sandboxId: string): {
  workerId: string;
  containerId: string;
} {
  // Format: "mm-{workerId}:{containerId}"
  const match = sandboxId.match(/^mm-([^:]+):(.+)$/);
  if (!match) {
    throw new Error(
      `Invalid OpenSandbox ID format: "${sandboxId}". Expected "mm-{workerId}:{containerId}"`,
    );
  }
  return { workerId: match[1]!, containerId: match[2]! };
}

function workerBaseUrl(hostname: string, port: number): string {
  return `http://${hostname}:${port}`;
}

// ---------------------------------------------------------------------------
// OpenSandboxSession
// ---------------------------------------------------------------------------

export class OpenSandboxSession implements ISandboxSession {
  public readonly sandboxProvider = "opensandbox" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly containerId: string,
    private readonly workerId: string,
    private readonly callbacks: OpenSandboxCallbacks,
  ) {}

  get sandboxId(): string {
    return `mm-${this.workerId}:${this.containerId}`;
  }

  get homeDir(): string {
    return HOME_DIR;
  }

  get repoDir(): string {
    return REPO_DIR;
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  async runCommand(
    command: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
    },
  ): Promise<string> {
    console.log(
      `[opensandbox] runCommand on ${this.baseUrl} container ${this.containerId}: ${command}`,
    );
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(
        this.url(`/v1/sandboxes/${this.containerId}/commands`),
        {
          method: "POST",
          headers: this.authHeaders(),
          body: JSON.stringify({ cmd: command }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Command timed out after ${timeoutMs}ms: ${command}`);
      }
      throw new Error(
        `[opensandbox] HTTP error on ${this.baseUrl} container ${this.containerId}: ${formatError(error)}`,
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `[opensandbox] Command request failed on ${this.baseUrl} container ${this.containerId}: HTTP ${response.status} — ${body}`,
      );
    }

    const result = (await response.json()) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    if (result.exitCode !== 0) {
      throw new Error(
        `Command failed with exit code ${result.exitCode}\nstdout: ${result.stdout || "(empty)"}\nstderr: ${result.stderr || "(empty)"}`,
      );
    }

    if (options?.onStdout && result.stdout) options.onStdout(result.stdout);
    if (options?.onStderr && result.stderr) options.onStderr(result.stderr);

    return result.stdout;
  }

  async runBackgroundCommand(
    command: string,
    _options?: BackgroundCommandOptions,
  ): Promise<void> {
    console.log(
      `[opensandbox] runBackgroundCommand on ${this.baseUrl} container ${this.containerId}: ${command}`,
    );
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      BACKGROUND_COMMAND_START_TIMEOUT_MS,
    );
    try {
      await fetch(this.url(`/v1/sandboxes/${this.containerId}/commands`), {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify({ cmd: command }),
        signal: controller.signal,
      });
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        console.error(
          `[opensandbox] Background command dispatch failed on ${this.baseUrl} container ${this.containerId}: ${formatError(error)}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async readTextFile(filePath: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        this.url(
          `/v1/sandboxes/${this.containerId}/files?path=${encodeURIComponent(filePath)}`,
        ),
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timer);
      throw new Error(
        `[opensandbox] readTextFile "${filePath}" failed on ${this.baseUrl}: ${formatError(error)}`,
      );
    }
    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `[opensandbox] readTextFile "${filePath}" failed on ${this.baseUrl}: HTTP ${response.status} — ${body}`,
      );
    }
    return response.text();
  }

  async writeTextFile(filePath: string, content: string): Promise<void> {
    await this._writeRaw(filePath, content, "text/plain");
  }

  async writeFile(filePath: string, content: Uint8Array): Promise<void> {
    await this._writeRaw(filePath, content, "application/octet-stream");
  }

  private async _writeRaw(
    filePath: string,
    body: BodyInit,
    contentType: string,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        this.url(
          `/v1/sandboxes/${this.containerId}/files?path=${encodeURIComponent(filePath)}`,
        ),
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": contentType,
          },
          body,
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timer);
      throw new Error(
        `[opensandbox] writeFile "${filePath}" failed on ${this.baseUrl}: ${formatError(error)}`,
      );
    }
    clearTimeout(timer);
    if (!response.ok) {
      const body2 = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `[opensandbox] writeFile "${filePath}" failed on ${this.baseUrl}: HTTP ${response.status} — ${body2}`,
      );
    }
  }

  async hibernate(): Promise<void> {
    console.log(
      `[opensandbox] Pausing container ${this.containerId} on ${this.baseUrl}`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(
        this.url(`/v1/sandboxes/${this.containerId}/pause`),
        {
          method: "POST",
          headers: this.authHeaders(),
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timer);
      throw new Error(
        `[opensandbox] hibernate failed on ${this.baseUrl} container ${this.containerId}: ${formatError(error)}`,
      );
    }
    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `[opensandbox] hibernate failed on ${this.baseUrl} container ${this.containerId}: HTTP ${response.status} — ${body}`,
      );
    }
  }

  async shutdown(): Promise<void> {
    console.log(
      `[opensandbox] Deleting container ${this.containerId} on ${this.baseUrl}`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(this.url(`/v1/sandboxes/${this.containerId}`), {
        method: "DELETE",
        headers: this.authHeaders(),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new Error(
        `[opensandbox] shutdown failed on ${this.baseUrl} container ${this.containerId}: ${formatError(error)}`,
      );
    }
    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(
        `[opensandbox] shutdown failed on ${this.baseUrl} container ${this.containerId}: HTTP ${response.status} — ${body}`,
      );
    }
    await this.callbacks.releaseAllocation(this.containerId, this.workerId);
  }
}

// ---------------------------------------------------------------------------
// OpenSandboxProvider
// ---------------------------------------------------------------------------

export class OpenSandboxProvider implements ISandboxProvider {
  constructor(private readonly callbacks: OpenSandboxCallbacks) {}

  async getSandboxOrNull(sandboxId: string): Promise<ISandboxSession | null> {
    try {
      const { workerId, containerId } = parseOpenSandboxId(sandboxId);
      const worker = await this.callbacks.getWorker(workerId);
      if (!worker) {
        console.warn(
          `[opensandbox] Worker ${workerId} not found for sandbox ${sandboxId}`,
        );
        return null;
      }
      const base = workerBaseUrl(worker.hostname, worker.port);

      // Resume the container in case it was paused.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      let resumeResponse: Response;
      try {
        resumeResponse = await fetch(
          `${base}/v1/sandboxes/${containerId}/resume`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${worker.apiKey}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
          },
        );
      } catch (error) {
        clearTimeout(timer);
        console.warn(
          `[opensandbox] Failed to resume container ${containerId} on ${base}: ${formatError(error)}`,
        );
        return null;
      }
      clearTimeout(timer);

      if (!resumeResponse.ok) {
        const body = await resumeResponse.text().catch(() => "(unreadable)");
        console.warn(
          `[opensandbox] Resume HTTP ${resumeResponse.status} for container ${containerId} on ${base}: ${body}`,
        );
        return null;
      }

      return new OpenSandboxSession(
        base,
        worker.apiKey,
        containerId,
        workerId,
        this.callbacks,
      );
    } catch (error) {
      console.warn(
        `[opensandbox] getSandboxOrNull failed for ${sandboxId}: ${formatError(error)}`,
      );
      return null;
    }
  }

  async getOrCreateSandbox(
    sandboxId: string | null,
    options: CreateSandboxOptions,
  ): Promise<ISandboxSession> {
    if (sandboxId) {
      const session = await this.getSandboxOrNull(sandboxId);
      if (!session) {
        throw new Error(`[opensandbox] Could not resume sandbox ${sandboxId}`);
      }
      return session;
    }

    // Allocate a worker atomically (throws "No Mac Mini workers available" if none free).
    const worker = await this.callbacks.allocateWorker();
    const base = workerBaseUrl(worker.hostname, worker.port);

    const envVars: Record<string, string> = {};
    for (const { key, value } of options.environmentVariables ?? []) {
      envVars[key] = value;
    }

    console.log(
      `[opensandbox] Creating container on worker ${base} (workerId=${worker.id})`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    let createResponse: Response;
    try {
      createResponse = await fetch(`${base}/v1/sandboxes`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${worker.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: SANDBOX_IMAGE,
          env: envVars,
          timeout: 3600,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      await this.callbacks.releaseAllocation("", worker.id).catch(() => {});
      throw new Error(
        `[opensandbox] Failed to create container on worker ${base}: ${formatError(error)}`,
      );
    }
    clearTimeout(timer);

    if (!createResponse.ok) {
      const body = await createResponse.text().catch(() => "(unreadable)");
      await this.callbacks.releaseAllocation("", worker.id).catch(() => {});
      throw new Error(
        `[opensandbox] Container creation failed on ${base}: HTTP ${createResponse.status} — ${body}`,
      );
    }

    const created = (await createResponse.json()) as { id: string };
    const containerId = created.id;
    console.log(`[opensandbox] Created container ${containerId} on ${base}`);

    await this.callbacks.recordAllocation(worker.id, containerId);

    return new OpenSandboxSession(
      base,
      worker.apiKey,
      containerId,
      worker.id,
      this.callbacks,
    );
  }

  async hibernateById(sandboxId: string): Promise<void> {
    try {
      const { workerId, containerId } = parseOpenSandboxId(sandboxId);
      const worker = await this.callbacks.getWorker(workerId);
      if (!worker) {
        console.warn(
          `[opensandbox] Worker ${workerId} not found for hibernateById ${sandboxId}`,
        );
        return;
      }
      const session = new OpenSandboxSession(
        workerBaseUrl(worker.hostname, worker.port),
        worker.apiKey,
        containerId,
        workerId,
        this.callbacks,
      );
      await session.hibernate();
      await this.callbacks.setAllocationPaused(containerId);
    } catch (error) {
      console.error(
        `[opensandbox] hibernateById failed for ${sandboxId}: ${formatError(error)}`,
      );
    }
  }

  async extendLife(_sandboxId: string): Promise<void> {
    // Mac Minis are always-on -- no timeout to extend.
  }
}
