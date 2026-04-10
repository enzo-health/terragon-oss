import {
  BackgroundCommandOptions,
  CreateSandboxOptions,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { getTemplateIdForSize } from "@leo/sandbox-image";
import { Sandbox } from "@e2b/code-interpreter";
import { retryAsync } from "@leo/utils/retry";

const HOME_DIR = "root";
const REPO_DIR = "repo";
const SLEEP_MS = 60 * 15 * 1000; // 15 minutes

async function resumeWithRetry(sandboxId: string): Promise<ISandboxSession> {
  const startTime = Date.now();
  return await retryAsync(
    async () => {
      console.log(`[e2b] Resuming sandbox ${sandboxId}...`);
      const sandbox = await Sandbox.resume(sandboxId, {
        // @ts-expect-error - autoPause is not public
        autoPause: true,
        timeoutMs: SLEEP_MS,
      });
      console.log(
        `[e2b] Resumed sandbox ${sandboxId} in ${Date.now() - startTime}ms`,
      );
      const session = new E2BSession(sandbox);
      // Attempt to run a command to check if the sandbox is running
      await session.runCommand("echo 'hello'", { cwd: "/" });
      console.log(`[e2b] Sandbox ${sandboxId} is running`);
      return session;
    },
    {
      label: `resume sandbox ${sandboxId}`,
      maxAttempts: 3,
      delayMs: 1000,
    },
  );
}

async function createWithRetry(
  templateId: string,
  envs: Record<string, string>,
): Promise<Sandbox> {
  return await retryAsync(
    async () => {
      console.log(`[e2b] Creating sandbox with templateId: ${templateId}...`);
      const startTime = Date.now();
      const sandbox = await Sandbox.create(templateId, {
        // @ts-expect-error - autoPause is not public
        autoPause: true,
        timeoutMs: SLEEP_MS,
        envs: {
          ...envs,
          // Uncomment this to debug git issues.
          // GIT_TRACE: "1",
        },
      });
      console.log(
        `[e2b] Created sandbox in ${Date.now() - startTime}ms`,
        sandbox.sandboxId,
      );
      return sandbox;
    },
    {
      label: `create sandbox with templateId ${templateId}`,
      maxAttempts: 3,
      delayMs: 1000,
    },
  );
}

class E2BSession implements ISandboxSession {
  public readonly sandboxProvider: "e2b" = "e2b";
  constructor(private sandbox: Sandbox) {}

  get homeDir(): string {
    return HOME_DIR;
  }

  get repoDir(): string {
    return REPO_DIR;
  }

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  async hibernate(): Promise<void> {
    await this.sandbox.pause();
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
    const startTime = Date.now();
    console.log("Running command:", command);
    try {
      const result = await this.sandbox.commands.run(command, {
        ...options,
        user: "root",
        envs: options?.env,
        cwd: options?.cwd || REPO_DIR,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
        timeoutMs: options?.timeoutMs || 0,
      });
      console.log(
        `Command result: ${result.stdout} (took ${Date.now() - startTime}ms)`,
      );
      return result.stdout;
    } catch (error) {
      console.error("Error running command:", JSON.stringify(error));
      // Handle timeout errors
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      // Check if it's a command execution error with result details
      if (error && typeof error === "object" && "result" in error) {
        const commandError = error as {
          result?: {
            error?: boolean;
            stderr?: string;
            exitCode?: number;
            stdout?: string;
          };
        };
        if (commandError.result?.error) {
          throw new Error(
            `Command failed${commandError.result.exitCode ? ` with exit code ${commandError.result.exitCode}` : ""}\n\nstdout:\n ${commandError.result.stdout || "(empty)"}\nstderr:\n ${commandError.result.stderr || "(empty)"}`,
          );
        }
      }
      throw error;
    }
  }

  async runBackgroundCommand(
    command: string,
    options?: BackgroundCommandOptions,
  ): Promise<void> {
    await this.sandbox.commands.run(command, {
      background: true,
      timeoutMs: options?.timeoutMs || 0,
      onStdout: (data) => {
        options?.onOutput?.(data);
      },
      onStderr: (data) => {
        options?.onOutput?.(data);
      },
      user: "root",
      envs: options?.env,
      cwd: options?.cwd || REPO_DIR,
    });
  }

  async shutdown(): Promise<void> {
    await this.sandbox.kill();
  }

  async readTextFile(path: string): Promise<string> {
    return await this.sandbox.files.read(path);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await this.sandbox.files.write(path, content);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await this.sandbox.files.write(path, content.buffer as ArrayBuffer);
  }
}

export class E2BProvider implements ISandboxProvider {
  constructor() {}

  async extendLife(sandboxId: string): Promise<void> {
    const sandbox = await Sandbox.connect(sandboxId);
    await sandbox.setTimeout(SLEEP_MS);
  }

  async getSandboxOrNull(sandboxId: string): Promise<ISandboxSession | null> {
    try {
      return await resumeWithRetry(sandboxId);
    } catch (error) {
      console.warn(`Failed to resume sandbox ${sandboxId}:`, error);
      return null;
    }
  }

  async getOrCreateSandbox(
    sandboxId: string | null,
    options: CreateSandboxOptions,
  ): Promise<ISandboxSession> {
    if (sandboxId) {
      return await resumeWithRetry(sandboxId);
    }
    // Convert environment variables array to object
    const envs: Record<string, string> = {};
    if (options.environmentVariables) {
      for (const { key, value } of options.environmentVariables) {
        envs[key] = value;
      }
    }
    const templateId = getTemplateIdForSize({
      provider: "e2b",
      size: options.sandboxSize,
    });
    const sandbox = await createWithRetry(templateId, envs);
    const e2bSession = new E2BSession(sandbox);
    return e2bSession;
  }

  async hibernateById(sandboxId: string): Promise<void> {
    const sandbox = await Sandbox.connect(sandboxId);
    console.log(await sandbox.commands.run("free -h"));
    const startTime = Date.now();
    console.log(`Pausing sandbox... ${sandboxId}`);
    await sandbox.pause({ requestTimeoutMs: 2 * 60 * 1000 }); // 2 minutes
    console.log(`Paused sandbox in ${Date.now() - startTime}ms`);
  }
}
