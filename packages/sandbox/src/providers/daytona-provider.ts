declare module "node:module" {
  export function _initPaths(): void;
}

import { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import type { VolumeMount } from "@daytonaio/sdk";
import { existsSync, readdirSync } from "node:fs";
import { createRequire, _initPaths } from "node:module";
import path from "node:path";
import {
  BackgroundCommandOptions,
  CreateSandboxOptions,
  DaytonaVolumeConfig,
  ISandboxProvider,
  ISandboxSession,
} from "../types";
import { nanoid } from "nanoid/non-secure";
import { bashQuote, safeEnvKey } from "../utils";
import { getTemplateIdForSize } from "@terragon/sandbox-image";
import { retryAsync } from "@terragon/utils/retry";
import { formatError } from "@terragon/utils/error";

const HOME_DIR = "root";
const DEFAULT_DIR = `/${HOME_DIR}`;
const REPO_DIR = "repo";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DAYTONA_AUTO_STOP_INTERVAL_MINUTES = 15;
const DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES = 6 * 60;
const DAYTONA_AUTO_DELETE_INTERVAL_MINUTES = 60 * 24 * 30;
const runtimeRequire = createRequire(import.meta.url);
const DAYTONA_SDK_RUNTIME_MODULES = [
  "busboy",
  "tar",
  "form-data",
  "fast-glob",
  "expand-tilde",
  "@iarna/toml",
] as const;
const DAYTONA_SDK_RUNTIME_PNPM_PACKAGES = [
  { pnpmPrefix: "busboy@", packagePath: "busboy" },
  { pnpmPrefix: "streamsearch@", packagePath: "streamsearch" },
  { pnpmPrefix: "tar@", packagePath: "tar" },
  { pnpmPrefix: "form-data@", packagePath: "form-data" },
  { pnpmPrefix: "fast-glob@", packagePath: "fast-glob" },
  { pnpmPrefix: "expand-tilde@", packagePath: "expand-tilde" },
  {
    pnpmPrefix: "@iarna+toml@",
    packagePath: path.join("@iarna", "toml"),
  },
] as const;

type DaytonaVolumeMount = VolumeMount & {
  subpath?: string;
};

async function reconcileLifecyclePolicy(
  sandbox: DaytonaSandbox,
): Promise<void> {
  const lifecycleUpdates = [
    {
      currentValue: sandbox.autoStopInterval,
      nextValue: DAYTONA_AUTO_STOP_INTERVAL_MINUTES,
      name: "auto-stop",
      apply: async () => {
        await sandbox.setAutostopInterval(DAYTONA_AUTO_STOP_INTERVAL_MINUTES);
      },
    },
    {
      currentValue: sandbox.autoArchiveInterval,
      nextValue: DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES,
      name: "auto-archive",
      apply: async () => {
        await sandbox.setAutoArchiveInterval(
          DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES,
        );
      },
    },
  ];

  await Promise.all(
    lifecycleUpdates
      .filter(
        (lifecycleUpdate) =>
          lifecycleUpdate.currentValue !== lifecycleUpdate.nextValue,
      )
      .map(async (lifecycleUpdate) => {
        try {
          await lifecycleUpdate.apply();
        } catch (error) {
          console.warn(
            `[daytona] Failed to reconcile ${lifecycleUpdate.name} lifecycle policy for sandbox ${sandbox.id}: ${formatError(error)}`,
          );
        }
      }),
  );
}

async function resumeWithRetry(sandboxId: string): Promise<DaytonaSandbox> {
  const startTime = Date.now();
  const daytona = getDaytonaOrThrow();
  return await retryAsync(
    async () => {
      console.log(`[daytona] Resuming sandbox ${sandboxId}...`);
      const sandbox = await daytona.get(sandboxId);
      console.log(`[daytona] Sandbox ${sandboxId} state: ${sandbox.state}`);
      if (sandbox.state === "stopping") {
        await sandbox.waitUntilStopped();
      }
      if (sandbox.state === "restoring" || sandbox.state === "starting") {
        await sandbox.waitUntilStarted();
      } else {
        await sandbox.start();
      }
      await reconcileLifecyclePolicy(sandbox);
      console.log(
        `[daytona] Resumed sandbox ${sandboxId} in ${Date.now() - startTime}ms`,
      );
      return sandbox;
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
  daytonaVolume?: DaytonaVolumeConfig,
): Promise<DaytonaSandbox> {
  const daytona = getDaytonaOrThrow();
  return await retryAsync(
    async () => {
      console.log(
        `[daytona] Creating sandbox with templateId: ${templateId}...`,
      );
      const startTime = Date.now();
      const volumes = daytonaVolume
        ? await getDaytonaVolumeMounts(daytona, daytonaVolume)
        : undefined;
      const sandbox = await daytona.create({
        user: "root",
        snapshot: templateId,
        envVars: envs,
        ...(volumes ? { volumes } : {}),
        autoStopInterval: DAYTONA_AUTO_STOP_INTERVAL_MINUTES,
        autoArchiveInterval: DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES,
        autoDeleteInterval: DAYTONA_AUTO_DELETE_INTERVAL_MINUTES,
      });
      console.log(
        `[daytona] Created sandbox in ${Date.now() - startTime}ms`,
        sandbox.id,
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

async function getDaytonaVolumeMounts(
  daytona: Daytona,
  daytonaVolume: DaytonaVolumeConfig,
): Promise<DaytonaVolumeMount[]> {
  const volume = await daytona.volume.get(daytonaVolume.volumeName, true);
  return [
    {
      volumeId: volume.id,
      mountPath: daytonaVolume.volumeMountPath,
      subpath: daytonaVolume.volumeSubpath,
    },
  ];
}

function getDaytonaOrThrow(): Daytona {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is not set");
  }
  assertDaytonaSdkRuntimeModulesAvailable();
  const daytona = new Daytona({ apiKey });
  return daytona;
}

function assertDaytonaSdkRuntimeModulesAvailable(): void {
  let sdkEntryPoint: string;
  try {
    sdkEntryPoint = runtimeRequire.resolve("@daytonaio/sdk");
  } catch (error) {
    throw new Error(
      `[daytona] @daytonaio/sdk is not resolvable in this runtime: ${formatError(error)}`,
    );
  }

  installDaytonaSdkNodePathFallback(sdkEntryPoint);
  const sdkRequire = createRequire(sdkEntryPoint);
  const missingModules = DAYTONA_SDK_RUNTIME_MODULES.flatMap((moduleName) => {
    try {
      sdkRequire(moduleName);
      return [];
    } catch (error) {
      return [`${moduleName}: ${formatError(error)}`];
    }
  });

  if (missingModules.length > 0) {
    throw new Error(
      [
        "[daytona] Daytona SDK runtime dependencies are missing.",
        "Refusing to allocate a sandbox because SDK file transfer calls would fail after creation.",
        "Missing modules:",
        ...missingModules.map((moduleName) => `- ${moduleName}`),
      ].join("\n"),
    );
  }
}

function installDaytonaSdkNodePathFallback(sdkEntryPoint: string): void {
  const pnpmStoreDir = findPnpmStoreDir(sdkEntryPoint);
  if (!pnpmStoreDir) {
    return;
  }

  const nodePathEntries = findDaytonaRuntimeNodePathEntries(pnpmStoreDir);
  if (nodePathEntries.length === 0) {
    return;
  }

  const existingEntries = new Set(
    (process.env.NODE_PATH ?? "").split(path.delimiter).filter(Boolean),
  );
  let changed = false;

  for (const entry of nodePathEntries) {
    if (!existingEntries.has(entry)) {
      existingEntries.add(entry);
      changed = true;
    }
  }

  if (!changed) {
    return;
  }

  process.env.NODE_PATH = Array.from(existingEntries).join(path.delimiter);
  _initPaths();
}

function findPnpmStoreDir(modulePath: string): string | null {
  const pathParts = modulePath.split(path.sep);
  const pnpmIndex = pathParts.lastIndexOf(".pnpm");
  if (pnpmIndex === -1) {
    return null;
  }
  return pathParts.slice(0, pnpmIndex + 1).join(path.sep);
}

function findDaytonaRuntimeNodePathEntries(pnpmStoreDir: string): string[] {
  let packageDirs: string[];
  try {
    packageDirs = readdirSync(pnpmStoreDir);
  } catch {
    return [];
  }

  return DAYTONA_SDK_RUNTIME_PNPM_PACKAGES.flatMap(
    ({ pnpmPrefix, packagePath }) => {
      return packageDirs.flatMap((packageDir) => {
        if (!packageDir.startsWith(pnpmPrefix)) {
          return [];
        }

        const nodePathEntry = path.join(
          pnpmStoreDir,
          packageDir,
          "node_modules",
        );
        if (!existsSync(path.join(nodePathEntry, packagePath))) {
          return [];
        }

        return [nodePathEntry];
      });
    },
  );
}

class DaytonaSession implements ISandboxSession {
  public readonly sandboxProvider: "daytona" = "daytona";

  constructor(private sandbox: DaytonaSandbox) {}

  get homeDir(): string {
    return HOME_DIR;
  }

  get repoDir(): string {
    return REPO_DIR;
  }

  get sandboxId(): string {
    return this.sandbox.id;
  }

  async hibernate(): Promise<void> {
    await hibernateSandbox(this.sandbox);
  }

  async runCommandWithSession(
    command: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      timeoutMs?: number;
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
      blockUntilComplete?: boolean;
    },
  ): Promise<{
    sessionId: string;
    cmdId: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
  }> {
    const sessionId = nanoid();
    try {
      const workDir = options?.cwd || REPO_DIR;
      const workDirPath = workDir.startsWith("/")
        ? workDir
        : path.join(DEFAULT_DIR, workDir);
      await this.sandbox.process.createSession(sessionId);
      const cdResult = await this.sandbox.process.executeSessionCommand(
        sessionId,
        {
          command: `cd ${workDirPath}`,
          runAsync: false,
        },
      );
      if (cdResult.exitCode !== undefined && cdResult.exitCode !== 0) {
        throw new Error(`Working directory does not exist: ${workDirPath}`);
      }
      if (options?.env) {
        for (const [key, value] of Object.entries(options.env)) {
          await this.sandbox.process.executeSessionCommand(sessionId, {
            command: `export ${safeEnvKey(key)}=${bashQuote(value)}`,
            runAsync: false,
          });
        }
      }
      const commandExecutionResult =
        await this.sandbox.process.executeSessionCommand(sessionId, {
          command,
          runAsync: true,
        });
      const commandId = commandExecutionResult.cmdId!;
      let stdoutLines: string[] = [];
      let stderrLines: string[] = [];
      const commandLogsPromise = this.sandbox.process.getSessionCommandLogs(
        sessionId,
        commandId,
        (chunk) => {
          options?.onStdout?.(chunk);
          stdoutLines.push(chunk);
        },
        (chunk) => {
          options?.onStderr?.(chunk);
          stderrLines.push(chunk);
        },
      );
      if (!options?.blockUntilComplete) {
        return { sessionId, cmdId: commandId };
      }
      const result = await Promise.race([
        commandLogsPromise,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => {
            resolve("timeout");
          }, options?.timeoutMs || DEFAULT_TIMEOUT_MS),
        ),
      ]);
      if (result === "timeout") {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      const commandResult = await this.sandbox.process.getSessionCommand(
        sessionId,
        commandId,
      );
      return {
        sessionId,
        cmdId: commandId,
        exitCode: commandResult.exitCode!,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n"),
      };
    } catch (error) {
      console.error("Error running command with session:", formatError(error));
      try {
        await this.sandbox.process.deleteSession(sessionId);
      } catch (error) {
        console.error("Error deleting session:", formatError(error));
      }
      if (
        error instanceof Error &&
        error.message.includes("Operation timed out")
      ) {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      throw error;
    }
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
    console.log("Running command:", command);
    const startTime = Date.now();
    if (
      typeof options?.onStdout === "function" ||
      typeof options?.onStderr === "function"
    ) {
      const commandResult = await this.runCommandWithSession(command, {
        env: options?.env,
        cwd: options?.cwd,
        timeoutMs: options?.timeoutMs,
        blockUntilComplete: true,
        onStdout: options?.onStdout,
        onStderr: options?.onStderr,
      });
      if (commandResult.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${commandResult.exitCode}\n\nstdout:\n ${commandResult.stdout || "(empty)"}\nstderr:\n ${commandResult.stderr || "(empty)"}`,
        );
      }
      return commandResult.stdout || "";
    }

    try {
      const workDir = options?.cwd || REPO_DIR;
      const workDirPath = workDir.startsWith("/")
        ? workDir
        : path.join(DEFAULT_DIR, workDir);
      const timeoutSecs = Math.ceil(
        (options?.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000,
      );
      const commandResult = await this.sandbox.process.executeCommand(
        command,
        workDirPath,
        options?.env,
        timeoutSecs,
      );
      console.log(`Command executed (took ${Date.now() - startTime}ms)`, {
        exitCode: commandResult.exitCode,
        result: commandResult.result,
        workDirPath,
      });
      if (commandResult.exitCode !== 0) {
        throw new Error(
          `Command failed with exit code ${commandResult.exitCode}\n\noutput:\n ${commandResult.result || "(empty)"}`,
        );
      }
      return commandResult.result || "";
    } catch (error) {
      console.error("Error running command:", formatError(error));
      if (
        error instanceof Error &&
        error.message.includes("command execution timeout")
      ) {
        throw new Error(`Command timed out after ${options?.timeoutMs || 0}ms`);
      }
      throw error;
    }
  }

  async runBackgroundCommand(
    command: string,
    options?: BackgroundCommandOptions,
  ): Promise<void> {
    console.log("Running command:", command);
    await this.runCommandWithSession(command, {
      env: options?.env,
      cwd: options?.cwd,
      timeoutMs: options?.timeoutMs,
      onStdout: options?.onOutput,
      onStderr: options?.onOutput,
      blockUntilComplete: false,
    });
  }

  async shutdown(): Promise<void> {
    await this.sandbox.stop();
    await this.sandbox.delete();
  }

  async readTextFile(path: string): Promise<string> {
    const file = await this.sandbox.fs.downloadFile(path);
    return file.toString();
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const fileContent = Buffer.from(content);
    await this.sandbox.fs.uploadFile(fileContent, path);
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    const fileContent = Buffer.from(content);
    await this.sandbox.fs.uploadFile(fileContent, path);
  }
}

export class DaytonaProvider implements ISandboxProvider {
  constructor() {}

  async extendLife(sandboxId: string): Promise<void> {
    const daytona = getDaytonaOrThrow();
    await retryAsync(
      async () => {
        const sandbox = await daytona.get(sandboxId);
        await sandbox.refreshData();
      },
      {
        label: `extend life for sandbox ${sandboxId}`,
        maxAttempts: 3,
        delayMs: 1000,
      },
    );
  }

  async getSandboxOrNull(sandboxId: string): Promise<ISandboxSession | null> {
    try {
      const sandbox = await resumeWithRetry(sandboxId);
      return new DaytonaSession(sandbox);
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
      const sandbox = await this.getSandboxOrNull(sandboxId);
      if (!sandbox) {
        throw new Error("Sandbox not found");
      }
      return sandbox;
    }
    // Convert environment variables array to object
    const envs: Record<string, string> = {};
    if (options.environmentVariables) {
      for (const { key, value } of options.environmentVariables) {
        envs[key] = value;
      }
    }
    const templateId =
      options.snapshotTemplateId ||
      getTemplateIdForSize({
        provider: "daytona",
        size: options.sandboxSize,
      });
    const sandbox = await createWithRetry(
      templateId,
      envs,
      options.daytonaVolume,
    );
    const session = new DaytonaSession(sandbox);
    await setupDaytonaOneTime(session);
    return session;
  }

  async hibernateById(sandboxId: string): Promise<void> {
    try {
      const daytona = getDaytonaOrThrow();
      const sandbox = await daytona.get(sandboxId);
      await hibernateSandbox(sandbox);
    } catch (error) {
      console.error(
        `Failed to hibernate sandbox ${sandboxId}:`,
        formatError(error),
      );
    }
  }
}

async function setupDaytonaOneTime(session: ISandboxSession): Promise<void> {
  const etcProfileDPromptShContents = [
    // Ensure PS1 is set so .bashrc won't early-return in login shells
    "[ -n \"${PS1-}\" ] || PS1='\\w $ '",
    "export PS1",
  ].join("\n");
  await session.runCommand(
    [
      `prompt_contents=${bashQuote(etcProfileDPromptShContents)}`,
      "if [ -d /etc/profile.d ] && [ -w /etc/profile.d ]; then",
      '  if [ ! -f /etc/profile.d/prompt.sh ]; then printf "%s\\n" "$prompt_contents" > /etc/profile.d/prompt.sh; chmod 644 /etc/profile.d/prompt.sh; fi',
      "else",
      `  bashrc=/${session.homeDir}/.bashrc`,
      '  if touch "$bashrc" 2>/dev/null && ! grep -qs "terragon-daytona-prompt" "$bashrc"; then',
      "    tmp_bashrc=$(mktemp)",
      '    { printf "%s\\n" "# terragon-daytona-prompt" "$prompt_contents"; cat "$bashrc"; } > "$tmp_bashrc"',
      '    cat "$tmp_bashrc" > "$bashrc"',
      '    rm -f "$tmp_bashrc"',
      "  fi",
      "fi",
    ].join("\n"),
    { cwd: "/" },
  );
}

async function hibernateSandbox(sandbox: DaytonaSandbox): Promise<void> {
  await sandbox.stop();
  // Rely on the auto-archive feature to archive the sandbox automatically
  // await sandbox.archive();
}
