import { Daytona, Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import type { VolumeMount } from "@daytonaio/sdk";
import { createRequire } from "node:module";
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
import { timeSandboxStartupStage } from "../startup-timing";

const HOME_DIR = "root";
const DEFAULT_DIR = `/${HOME_DIR}`;
const REPO_DIR = "repo";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DAYTONA_AUTO_STOP_INTERVAL_MINUTES = 15;
const DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES = 6 * 60;
const DAYTONA_AUTO_DELETE_INTERVAL_MINUTES = 60 * 24 * 30;
const DAYTONA_WRITE_BASE64_CHUNK_CHARS = 64 * 1024;
const DAYTONA_VOLUME_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const runtimeRequire = createRequire(import.meta.url);

type DaytonaVolumeForMount = {
  id: unknown;
  name?: unknown;
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
  try {
    return await retryAsync(
      async () => {
        console.log(
          `[daytona] Creating sandbox with templateId: ${templateId}...`,
        );
        const startTime = Date.now();
        const daytona = getDaytonaOrThrow();
        const timingAttrs = { templateId, hasVolume: Boolean(daytonaVolume) };
        const volumes = daytonaVolume
          ? await timeSandboxStartupStage(
              "daytona.volume.mounts",
              timingAttrs,
              () => getDaytonaVolumeMounts(daytona, daytonaVolume),
            )
          : undefined;
        const sandbox = await timeSandboxStartupStage(
          "daytona.provider.create",
          timingAttrs,
          () =>
            daytona.create({
              user: "root",
              snapshot: templateId,
              envVars: envs,
              ...(volumes ? { volumes } : {}),
              autoStopInterval: DAYTONA_AUTO_STOP_INTERVAL_MINUTES,
              autoArchiveInterval: DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES,
              autoDeleteInterval: DAYTONA_AUTO_DELETE_INTERVAL_MINUTES,
            }),
        );
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
  } catch (error) {
    const volumeContext = daytonaVolume
      ? ` with Daytona volume "${daytonaVolume.volumeName}" mounted at "${daytonaVolume.volumeMountPath}"`
      : "";
    throw new Error(
      `[daytona] Failed to create sandbox${volumeContext}: ${formatError(error)}`,
    );
  }
}

function normalizeRequiredDaytonaString(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`[daytona] ${label} must be a non-empty string`);
  }
  return normalized;
}

function normalizeOptionalDaytonaString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeDaytonaVolumeMountId(
  value: unknown,
  volumeName: string,
): string {
  const volumeId = normalizeRequiredDaytonaString(
    value,
    `Volume "${volumeName}" id`,
  );
  if (!DAYTONA_VOLUME_UUID_PATTERN.test(volumeId)) {
    throw new Error(
      `[daytona] Volume "${volumeName}" id "${volumeId}" is not a mountable UUID`,
    );
  }
  return volumeId;
}

async function getDaytonaVolumeMounts(
  daytona: Daytona,
  daytonaVolume: DaytonaVolumeConfig,
): Promise<VolumeMount[]> {
  const volume = await getDaytonaVolumeForMount(daytona, daytonaVolume);
  const volumeId = normalizeDaytonaVolumeMountId(
    volume.id,
    daytonaVolume.volumeName,
  );
  const mountPath = normalizeRequiredDaytonaString(
    daytonaVolume.volumeMountPath,
    `Volume "${daytonaVolume.volumeName}" mount path`,
  );
  const subpath = normalizeOptionalDaytonaString(daytonaVolume.volumeSubpath);
  return [
    {
      volumeId,
      mountPath,
      ...(subpath ? { subpath } : {}),
    },
  ];
}

async function getDaytonaVolumeForMount(
  daytona: Daytona,
  daytonaVolume: DaytonaVolumeConfig,
): Promise<DaytonaVolumeForMount> {
  const volumeName = normalizeRequiredDaytonaString(
    daytonaVolume.volumeName,
    "Daytona volume name",
  );
  try {
    const volumes = await daytona.volume.list();
    const listedVolume = findDaytonaVolumeByName(volumes, volumeName);
    if (listedVolume) {
      return listedVolume;
    }
  } catch {
    // Fall through to get-or-create so a list outage does not disable volume use.
  }
  const volume = await daytona.volume.get(volumeName, true);
  if (
    DAYTONA_VOLUME_UUID_PATTERN.test(
      normalizeOptionalDaytonaString(volume.id) ?? "",
    )
  ) {
    return volume;
  }
  try {
    const volumes = await daytona.volume.list();
    const listedVolume = findDaytonaVolumeByName(volumes, volumeName);
    if (listedVolume) {
      return listedVolume;
    }
  } catch {
    // The final volume id validation reports the unmountable id from get-or-create.
  }
  return volume;
}

function findDaytonaVolumeByName<T extends DaytonaVolumeForMount>(
  volumes: T[],
  volumeName: string,
): T | undefined {
  return volumes.find(
    (volume) => normalizeOptionalDaytonaString(volume.name) === volumeName,
  );
}

function getDaytonaOrThrow(): Daytona {
  assertDaytonaSdkRuntimeModulesAvailable();
  const apiKey = process.env.DAYTONA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("DAYTONA_API_KEY is not set");
  }
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

  if (path.isAbsolute(sdkEntryPoint)) {
    installDaytonaSdkNodePathFallback(sdkEntryPoint);
  }

  const sdkRequire = createRequire(
    path.isAbsolute(sdkEntryPoint) ? sdkEntryPoint : import.meta.url,
  );
  for (const moduleName of ["form-data"]) {
    try {
      sdkRequire.resolve(moduleName);
    } catch (error) {
      throw new Error(
        `[daytona] @daytonaio/sdk runtime dependency "${moduleName}" is not resolvable from ${sdkEntryPoint}. Run pnpm install so transitive SDK dependencies are available. ${formatError(error)}`,
      );
    }
  }
}

function installDaytonaSdkNodePathFallback(sdkEntryPoint: string): void {
  const sdkNodeModules = findAncestorNodeModules(path.dirname(sdkEntryPoint));
  if (!sdkNodeModules) {
    return;
  }
  const currentNodePath = process.env.NODE_PATH ?? "";
  const entries = currentNodePath.split(path.delimiter).filter(Boolean);
  if (entries.includes(sdkNodeModules)) {
    return;
  }
  process.env.NODE_PATH = [sdkNodeModules, ...entries].join(path.delimiter);
  try {
    runtimeRequire("node:module").Module._initPaths();
  } catch {
    // Best effort: the explicit createRequire checks still report unresolved deps.
  }
}

function findAncestorNodeModules(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (path.basename(current) === "node_modules") {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
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
    return await this.runFileCommand(`cat -- ${bashQuote(path)}`);
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await this.writeContent(path, Buffer.from(content));
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await this.writeContent(path, Buffer.from(content));
  }

  private async writeContent(path: string, content: Buffer): Promise<void> {
    const uploadId = nanoid();
    const encodedPath = `/tmp/terragon-upload-${uploadId}.b64`;
    const decodedPath = `/tmp/terragon-upload-${uploadId}.out`;
    const quotedPath = bashQuote(path);
    const quotedEncodedPath = bashQuote(encodedPath);
    const quotedDecodedPath = bashQuote(decodedPath);
    const encodedContent = content.toString("base64");

    try {
      await this.runFileCommand(
        `mkdir -p -- "$(dirname -- ${quotedPath})" && : > ${quotedEncodedPath}`,
      );
      for (
        let offset = 0;
        offset < encodedContent.length;
        offset += DAYTONA_WRITE_BASE64_CHUNK_CHARS
      ) {
        const chunk = encodedContent.slice(
          offset,
          offset + DAYTONA_WRITE_BASE64_CHUNK_CHARS,
        );
        await this.runFileCommand(
          `printf %s ${bashQuote(chunk)} >> ${quotedEncodedPath}`,
        );
      }
      await this.runFileCommand(
        `base64 -d ${quotedEncodedPath} > ${quotedDecodedPath} && mv ${quotedDecodedPath} ${quotedPath}`,
      );
    } finally {
      await this.runFileCommand(
        `rm -f ${quotedEncodedPath} ${quotedDecodedPath}`,
      ).catch((error) => {
        console.warn(
          `[daytona] Failed to clean up upload temp files for ${path}: ${formatError(error)}`,
        );
      });
    }
  }

  private async runFileCommand(command: string): Promise<string> {
    try {
      const commandResult = await this.sandbox.process.executeCommand(
        command,
        "/",
        undefined,
        Math.ceil(DEFAULT_TIMEOUT_MS / 1000),
      );
      if (commandResult.exitCode !== 0) {
        throw new Error(
          `File command failed with exit code ${commandResult.exitCode}\n\noutput:\n ${commandResult.result || "(empty)"}`,
        );
      }
      return commandResult.result || "";
    } catch (error) {
      console.error("Error running Daytona file command:", formatError(error));
      if (
        error instanceof Error &&
        error.message.includes("command execution timeout")
      ) {
        throw new Error(`Command timed out after ${DEFAULT_TIMEOUT_MS}ms`);
      }
      throw error;
    }
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
    const configuredTemplateId = normalizeOptionalDaytonaString(
      options.snapshotTemplateId,
    );
    const templateId = normalizeRequiredDaytonaString(
      configuredTemplateId ??
        getTemplateIdForSize({
          provider: "daytona",
          size: options.sandboxSize,
        }),
      "snapshot template id",
    );
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
