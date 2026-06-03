import { CreateSandboxOptions, ISandboxSession } from "./types";
import {
  parsePnpmProgressLine,
  InstallProgressSnapshot,
} from "./install-progress-parser";
import {
  updateDaemonIfOutdated,
  restartDaemonIfNotRunning,
  installDaemon,
  MCP_SERVER_FILE_PATH,
} from "./daemon";
import {
  generateRandomBranchName,
  generateRandomBranchSuffix,
  bashQuote,
} from "./utils";
import { McpConfig } from "./mcp-config";
import { AIAgent, AIAgentCredentials } from "@terragon/agent/types";
import { terragonSetupScriptTimeoutMs } from "./constants";
import { buildAmpSettings } from "./agents/amp-settings";
import { buildCodexToml } from "./agents/codex-config";
import { buildGeminiSettings } from "./agents/gemini-settings";
import {
  buildOpencodeConfig,
  OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT,
} from "./agents/opencode-config";
import { buildClaudeCodeSettings } from "./agents/claude-settings";
import { buildQualityCheckScript } from "./agents/quality-check";
import { getEnv } from "./env";
import {
  DAYTONA_VOLUME_PROFILE_PATH,
  getDaytonaVolumeProfileContents,
  getDaytonaVolumeSetupDirs,
} from "./daytona-volume";
import path from "path";
import { timeSandboxStartupStage } from "./startup-timing";

const CLAUDE_CODE_VERSION = "2.1.161";
const SNAPSHOT_BOOT_GIT_CLEAN_EXCLUDES = [
  "node_modules",
  "**/node_modules",
  ".turbo",
  "**/.turbo",
] as const;
const CLAUDE_WORKSPACE_CHOWN_PRUNES = [
  "node_modules",
  ".next",
  ".turbo",
] as const;
const NEXT_CONFIG_PATHSPECS = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "*/next.config.js",
  "*/next.config.mjs",
  "*/next.config.ts",
  "*/*/next.config.js",
  "*/*/next.config.mjs",
  "*/*/next.config.ts",
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSandboxAgentBaseUrl(
  options: Pick<CreateSandboxOptions, "environmentVariables">,
): string | null {
  const entry = options.environmentVariables.find(
    (envVar) => envVar.key === "SANDBOX_AGENT_BASE_URL",
  );
  if (!entry || !entry.value) {
    return null;
  }
  return entry.value.trim().replace(/\/+$/, "");
}

function isLocalSandboxAgentUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

async function ensureSandboxAgentRunning({
  session,
  baseUrl,
}: {
  session: ISandboxSession;
  baseUrl: string;
}): Promise<void> {
  if (!isLocalSandboxAgentUrl(baseUrl)) {
    return;
  }

  let port = "2468";
  try {
    const parsed = new URL(baseUrl);
    port = parsed.port || "2468";
  } catch {
    return;
  }

  // Run all sandbox-agent checks from root dir since /root/repo may not exist yet
  const cmdOpts = { cwd: "/" };

  // Single round-trip: check if running, find binary, or report not found
  const result = await session.runCommand(
    `if ps -ef | grep sandbox-agent | grep -F " --port ${port}" | grep -v grep >/dev/null 2>&1; then` +
      ` echo RUNNING;` +
      ` elif command -v sandbox-agent >/dev/null 2>&1; then which sandbox-agent;` +
      ` elif test -x /usr/bin/sandbox-agent; then echo /usr/bin/sandbox-agent;` +
      ` elif test -x /usr/local/bin/sandbox-agent; then echo /usr/local/bin/sandbox-agent;` +
      ` else echo NOT_FOUND; fi`,
    cmdOpts,
  );
  const output = result.trim();
  if (output === "RUNNING") return;
  if (output === "NOT_FOUND") {
    throw new Error(
      "sandbox-agent is enabled but not installed in the sandbox image. Install @sandbox-agent/cli in the image and set SANDBOX_AGENT_BASE_URL.",
    );
  }
  const sandboxAgentBin = output;

  // Increase ACP proxy timeout from 120s default to 10 minutes.
  // session/prompt can take many minutes for complex coding tasks.
  await session.runBackgroundCommand(
    `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=600000 ${sandboxAgentBin} server --no-token --host 127.0.0.1 --port ${port} >> /tmp/sandbox-agent.log 2>&1`,
    { cwd: "/" },
  );
}

async function waitForSandboxAgentHealth({
  session,
  baseUrl,
  maxRetries = 12,
  retryDelayMs = 500,
}: {
  session: ISandboxSession;
  baseUrl: string;
  maxRetries?: number;
  retryDelayMs?: number;
}) {
  const healthUrl = `${baseUrl}/v1/health`;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await session.runCommand(
        `curl -fsS --connect-timeout 2 --max-time 3 ${bashQuote(healthUrl)}`,
        { cwd: "/" },
      );
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxRetries - 1) {
        throw lastError;
      }
      const delay = Math.min(retryDelayMs * Math.pow(2, attempt), 1000);
      await sleep(delay);
    }
  }
}

async function probeSandboxAgentEndpoint({
  session,
  options,
}: {
  session: ISandboxSession;
  options: CreateSandboxOptions;
}) {
  await timeSandboxStartupStage(
    "sandbox_agent.probe",
    { provider: options.sandboxProvider },
    async () => {
      const baseUrl = getSandboxAgentBaseUrl(options);
      if (!baseUrl) {
        return;
      }
      const healthMaxRetries = options.sandboxProvider === "docker" ? 30 : 12;
      const healthRetryDelayMs =
        options.sandboxProvider === "docker" ? 750 : 500;
      await ensureSandboxAgentRunning({ session, baseUrl });
      await waitForSandboxAgentHealth({
        session,
        baseUrl,
        maxRetries: healthMaxRetries,
        retryDelayMs: healthRetryDelayMs,
      });
      try {
        await session.runCommand(
          `curl -fsS ${bashQuote(`${baseUrl}/v1/acp`)}`,
          { cwd: "/" },
        );
        return;
      } catch {
        await session.runCommand(
          `curl -fsS ${bashQuote(`${baseUrl}/v1/rpc`)}`,
          { cwd: "/" },
        );
      }
    },
  );
}

async function createNewBranch({
  session,
  threadName,
  generateBranchName,
}: {
  session: ISandboxSession;
  threadName: string | null;
  generateBranchName: (threadName: string | null) => Promise<string | null>;
}): Promise<void> {
  // Generate a smart branch name based on the thread name
  let baseBranchName = await generateBranchName?.(threadName);
  if (!baseBranchName) {
    baseBranchName = generateRandomBranchName();
  }

  // Always append unique hash to avoid conflicts
  let branchName: string;
  let attempts = 0;
  const maxAttempts = 5;

  while (attempts < maxAttempts) {
    const uniqueSuffix = generateRandomBranchSuffix();
    branchName = `${baseBranchName}-${uniqueSuffix}`;

    // Check if the branch already exists (locally or remotely)
    const localBranchRef = `refs/heads/${branchName}`;
    const remoteBranchRef = `refs/remotes/origin/${branchName}`;
    const branchCheckResult = await session.runCommand(
      `(git show-ref --verify --quiet ${bashQuote(localBranchRef)} || git show-ref --verify --quiet ${bashQuote(remoteBranchRef)}) && echo "exists" || echo "not-exists"`,
    );
    if (branchCheckResult.trim() === "exists") {
      console.log(`Branch ${branchName} already exists, retrying...`);
      attempts++;
      continue;
    }
    console.log(`Creating branch with hash: ${branchName}`);
    await session.runCommand(`git checkout -b ${bashQuote(branchName)}`);
    return;
  }

  throw new Error(
    `Failed to generate unique branch name after ${maxAttempts} attempts`,
  );
}

/**
 * Run this function one time when creating a sandbox.
 */
export async function setupSandboxOneTime(
  session: ISandboxSession,
  options: CreateSandboxOptions,
) {
  return await timeSandboxStartupStage(
    "sandbox.setup.one_time",
    getSandboxSetupTimingAttrs(options),
    async () => {
      const dotProfileContents = [
        "ulimit -c 0",
        "if [ -f ~/.bashrc ]; then . ~/.bashrc; fi",
      ].join("\n");
      await session.runCommand(
        `echo ${bashQuote(dotProfileContents)} >> ~/.profile`,
        { cwd: "/" },
      );

      await timeSandboxStartupStage(
        "daytona.volume.paths",
        getSandboxSetupTimingAttrs(options),
        () => setupDaytonaVolumePaths(session, options),
      );

      if (!options.snapshotTemplateId) {
        await gitCloneRepo(session, options);
      } else {
        // Repo already cloned in snapshot — update git remote with a fresh token,
        // then fast-forward to the live base branch.
        await options.onStatusUpdate({
          sandboxId: session.sandboxId,
          sandboxStatus: "booting",
          bootingStatus: "cloning-repo",
        });
        await session.runCommand(
          `git remote set-url origin "https://\${GITHUB_ACCESS_TOKEN}@github.com/${options.githubRepoFullName}.git"`,
          { env: { GITHUB_ACCESS_TOKEN: options.githubAccessToken } },
        );
        // The snapshot froze the working tree at the commit baked in at build time,
        // which may now be behind. Fetch + hard-reset to the live base branch so the
        // task's new branch forks from the current tip, not the stale commit. The
        // fetch is incremental — the snapshot already holds nearly every object.
        // Best-effort: a deleted/renamed base branch must not fail the boot.
        await timeSandboxStartupStage(
          "git.snapshot.refresh",
          getSandboxSetupTimingAttrs(options),
          async () => {
            try {
              await session.runCommand(
                [
                  `git fetch --no-tags --filter=blob:none origin ${bashQuote(`${options.repoBaseBranchName}:refs/remotes/origin/${options.repoBaseBranchName}`)}`,
                  `git reset --hard ${bashQuote(`origin/${options.repoBaseBranchName}`)}`,
                ].join(" && "),
                { env: { GITHUB_ACCESS_TOKEN: options.githubAccessToken } },
              );
            } catch (error) {
              console.warn(
                `[snapshot-boot] Failed to refresh ${options.repoBaseBranchName} from origin; using baked commit:`,
                error,
              );
            }
          },
        );
      }
      await session.runCommand(
        [
          `git config user.name ${bashQuote(options.userName)}`,
          `git config user.email ${bashQuote(options.userEmail)}`,
          `git config core.pager cat`,
        ].join(" && "),
      );
      if (options.createNewBranch) {
        await createNewBranch({
          session,
          threadName: options.threadName,
          generateBranchName: options.generateBranchName,
        });
      } else if (options.branchName) {
        // Checkout specific branch when createNewBranch is false but branchName is provided
        await session.runCommand(
          `git checkout ${bashQuote(options.branchName)}`,
        );
      }
      await timeSandboxStartupStage(
        "git.clean",
        getSandboxSetupTimingAttrs(options),
        () =>
          session.runCommand(getGitCleanCommand(options)).then(() => undefined),
      );
      await timeSandboxStartupStage(
        "daytona.volume.workspace_links",
        getSandboxSetupTimingAttrs(options),
        () => setupDaytonaVolumeWorkspaceLinks(session, options),
      );

      await options.onStatusUpdate({
        sandboxId: session.sandboxId,
        sandboxStatus: "booting",
        bootingStatus: "installing-agent",
      });

      const daemonInstallAndProbe = timeSandboxStartupStage(
        "daemon.install",
        getSandboxSetupTimingAttrs(options),
        () =>
          installDaemon({
            session,
            environmentVariables: options.environmentVariables || [],
            githubAccessToken: options.githubAccessToken,
            agentCredentials: options.agentCredentials,
            userMcpConfig: options.mcpConfig,
            publicUrl: options.publicUrl,
            featureFlags: options.featureFlags,
          }),
      ).then(() => probeSandboxAgentEndpoint({ session, options }));

      // Only run terragon-setup.sh if not explicitly skipped and no snapshot
      if (options.skipSetupScript || options.snapshotTemplateId) {
        console.log("Skipping setup script (snapshot or explicit skip)");
        await daemonInstallAndProbe;
      } else if (options.backgroundSetupScript) {
        // Background mode: install the dependency barrier, then launch the setup
        // script detached so the agent can dispatch immediately. Boot reaches
        // `booting-done` once the daemon probe resolves — setup keeps running.
        await options.onStatusUpdate({
          sandboxId: session.sandboxId,
          sandboxStatus: "booting",
          bootingStatus: "running-setup-script",
        });
        await Promise.all([
          daemonInstallAndProbe,
          timeSandboxStartupStage(
            "setup_script.background_launch",
            getSandboxSetupTimingAttrs(options),
            () => launchSetupScriptInBackground({ session, options }),
          ),
        ]);
      } else {
        // Daemon startup (~15s for Node.js spawn on Daytona) and the setup script
        // are fully independent — run them in parallel to hide the spawn latency.
        await options.onStatusUpdate({
          sandboxId: session.sandboxId,
          sandboxStatus: "booting",
          bootingStatus: "running-setup-script",
        });
        await Promise.all([
          daemonInstallAndProbe,
          timeSandboxStartupStage(
            "setup_script.run",
            getSandboxSetupTimingAttrs(options),
            () =>
              runSetupScript({
                session,
                options: {
                  environmentVariables: options.environmentVariables,
                  githubAccessToken: options.githubAccessToken,
                  agentCredentials: options.agentCredentials,
                  setupScript: options.setupScript,
                  onInstallProgress: options.onInstallProgress,
                },
              }),
          ),
        ]);
      }

      await timeSandboxStartupStage(
        "claude.workspace_prep",
        getSandboxSetupTimingAttrs(options),
        () => prepareClaudeCodeRunUserWorkspace(session, options),
      );
    },
  );
}

function getSandboxSetupTimingAttrs(options: CreateSandboxOptions) {
  return {
    provider: options.sandboxProvider,
    repo: options.githubRepoFullName,
    branch: options.repoBaseBranchName,
    hasSnapshotTemplate: Boolean(options.snapshotTemplateId),
    hasDaytonaVolume: Boolean(options.daytonaVolume),
    agent: options.agent ?? null,
  };
}

function getGitCleanCommand(options: CreateSandboxOptions): string {
  if (!options.snapshotTemplateId) {
    return "git clean -fxd";
  }

  const excludes = SNAPSHOT_BOOT_GIT_CLEAN_EXCLUDES.map(
    (exclude) => `-e ${bashQuote(exclude)}`,
  ).join(" ");
  return `git clean -fxd ${excludes}`;
}

async function setupDaytonaVolumeWorkspaceLinks(
  session: ISandboxSession,
  options: CreateSandboxOptions,
): Promise<void> {
  const volume = options.daytonaVolume;
  if (!volume) {
    return;
  }

  const repoPath = path.posix.join("/", session.homeDir, session.repoDir);
  const nextConfigPathspecs = NEXT_CONFIG_PATHSPECS.map(bashQuote).join(" ");
  await session.runCommand(
    [
      `mkdir -p ${bashQuote(volume.nextCachePath)}`,
      `git -C ${bashQuote(repoPath)} ls-files -z -- ${nextConfigPathspecs} | while IFS= read -r -d '' config; do`,
      '  rel_dir="$(dirname "$config")"',
      "  app_dir=" + bashQuote(repoPath) + '/"$rel_dir"',
      `  target=${bashQuote(volume.nextCachePath)}/"$rel_dir/cache"`,
      '  next_dir="$app_dir/.next"',
      '  link="$next_dir/cache"',
      '  mkdir -p "$next_dir"',
      '  mkdir -p "$target"',
      '  if [ -L "$link" ]; then continue; fi',
      '  if [ -d "$link" ]; then rm -rf "$link"; fi',
      '  ln -s "$target" "$link"',
      "done",
    ].join("\n"),
    { cwd: "/" },
  );
}

async function setupDaytonaVolumePaths(
  session: ISandboxSession,
  options: CreateSandboxOptions,
): Promise<void> {
  const volume = options.daytonaVolume;
  if (!volume) {
    return;
  }

  const dirs = getDaytonaVolumeSetupDirs(volume);
  await session.runCommand(`mkdir -p ${dirs.map(bashQuote).join(" ")}`, {
    cwd: "/",
  });

  await session.writeTextFile(
    DAYTONA_VOLUME_PROFILE_PATH,
    getDaytonaVolumeProfileContents(volume),
  );
  await session.runCommand(
    `chmod 644 ${bashQuote(DAYTONA_VOLUME_PROFILE_PATH)} && grep -qs 'terragon-volume' /${session.homeDir}/.bashrc 2>/dev/null || echo '. ${DAYTONA_VOLUME_PROFILE_PATH} # terragon-volume' >> /${session.homeDir}/.bashrc`,
    { cwd: "/" },
  );
}

/**
 * Launch the setup script detached inside the sandbox and install a dependency
 * barrier, then return immediately so the agent can be dispatched while setup
 * runs.
 *
 * Two artifacts make this safe:
 *   - A sentinel (`<home>/.terragon/setup-complete`) plus an exit-code file,
 *     written by the detached runner when setup finishes.
 *   - PATH-shimmed `pnpm`/`npm`/`yarn`/`node` in `<home>/.terragon/bin` that
 *     block until the sentinel exists, then exec the real binary (or fail loudly
 *     if setup exited non-zero). The shim re-resolves the real binary by
 *     dropping its own dir from PATH, so there is no infinite loop and nothing
 *     is baked at a fixed path.
 *
 * NOTE: interception depends on the agent's shell picking up the prepended PATH
 * (written to /etc/profile.d and ~/.bashrc). This is the part that must be
 * verified against a live sandbox before enabling the `backgroundSetupScript`
 * flag in production.
 */
export async function launchSetupScriptInBackground({
  session,
  options,
}: {
  session: ISandboxSession;
  options: Pick<
    CreateSandboxOptions,
    | "environmentVariables"
    | "githubAccessToken"
    | "agentCredentials"
    | "setupScript"
  >;
}): Promise<void> {
  const stateDir = `/${session.homeDir}/.terragon`;
  const binDir = `${stateDir}/bin`;
  const sentinel = `${stateDir}/setup-complete`;
  const exitCodeFile = `${stateDir}/setup-exit-code`;
  const logFile = `${stateDir}/setup.log`;
  const repoPath = `/${session.homeDir}/${session.repoDir}`;
  const customScriptPath = "/tmp/terragon-setup-custom.sh";
  const runnerPath = "/tmp/terragon-bg-setup-runner.sh";
  const shimPath = `${binDir}/terragon-barrier-shim.sh`;
  const installerPath = "/tmp/terragon-bg-install-barrier.sh";
  const env = getEnv({
    userEnv: options.environmentVariables ?? [],
    githubAccessToken: options.githubAccessToken,
    agentCredentials: options.agentCredentials,
    overrides: { CI: "true", TERM: "xterm" },
  });

  const runSetupBlock = options.setupScript
    ? `bash -x ${customScriptPath}`
    : `if [ -f terragon-setup.sh ]; then chmod +x terragon-setup.sh && bash -x ./terragon-setup.sh; fi`;

  const runner = [
    "#!/usr/bin/env bash",
    `mkdir -p ${stateDir}`,
    `cd ${repoPath} || { echo 1 > ${exitCodeFile}; touch ${sentinel}; exit 1; }`,
    runSetupBlock,
    "code=$?",
    `echo "$code" > ${exitCodeFile}`,
    `touch ${sentinel}`,
    "",
  ].join("\n");

  // A single shim file, symlinked per tool. `$0`'s basename names the tool;
  // dropping our bin dir from PATH lets `command -v` find the genuine binary.
  const shim = [
    "#!/usr/bin/env bash",
    `while [ ! -f ${sentinel} ]; do sleep 1; done`,
    `code="$(cat ${exitCodeFile} 2>/dev/null || echo 0)"`,
    'if [ "$code" != "0" ]; then',
    `  echo "terragon: environment setup failed (exit $code); see ${logFile}" >&2`,
    '  exit "$code"',
    "fi",
    'self="$(basename "$0")"',
    `real="$(PATH="$(printf %s "$PATH" | tr ':' '\\n' | grep -vx '${binDir}' | paste -sd: -)" command -v "$self")"`,
    'if [ -z "$real" ]; then',
    '  echo "terragon: could not resolve real $self" >&2',
    "  exit 127",
    "fi",
    'exec "$real" "$@"',
    "",
  ].join("\n");

  const installer = [
    "#!/usr/bin/env bash",
    `mkdir -p ${binDir}`,
    `chmod +x ${shimPath}`,
    "for tool in pnpm npm yarn node; do",
    `  ln -sf ${shimPath} ${binDir}/$tool`,
    "done",
    `echo 'export PATH=${binDir}:$PATH' > /etc/profile.d/00-terragon-setup-barrier.sh`,
    `grep -qs 'terragon-setup-barrier' /${session.homeDir}/.bashrc 2>/dev/null || echo '. /etc/profile.d/00-terragon-setup-barrier.sh # terragon-setup-barrier' >> /${session.homeDir}/.bashrc`,
    "",
  ].join("\n");

  if (options.setupScript) {
    await session.writeTextFile(customScriptPath, options.setupScript);
    await session.runCommand(`chmod +x ${customScriptPath}`);
  }

  // Install the barrier synchronously so the shims exist before the agent runs.
  await session.runCommand(`mkdir -p ${binDir}`);
  await session.writeTextFile(shimPath, shim);
  await session.writeTextFile(installerPath, installer);
  await session.runCommand(`bash ${installerPath}`);

  // Launch setup detached. `nohup ... &` returns immediately; the runner keeps
  // executing in the sandbox and writes the sentinel when done.
  await session.writeTextFile(runnerPath, runner);
  await session.runCommand(
    `nohup bash ${runnerPath} > ${logFile} 2>&1 & echo "terragon background setup launched"`,
    { env },
  );
}

export async function gitCloneRepo(
  session: ISandboxSession,
  options: CreateSandboxOptions,
): Promise<void> {
  await options.onStatusUpdate({
    sandboxId: session.sandboxId,
    sandboxStatus: "booting",
    bootingStatus: "cloning-repo",
  });
  // Build clone command with blobless clone and branch specification
  let cloneCommand = `git clone --filter=blob:none --no-recurse-submodules`;
  // Add branch specification if provided
  if (options.repoBaseBranchName) {
    cloneCommand += ` --branch ${bashQuote(options.repoBaseBranchName)}`;
  }
  cloneCommand += ` https://github.com/${options.githubRepoFullName}.git ${session.repoDir}`;
  await session.runCommand(cloneCommand, { cwd: `/${session.homeDir}` });

  // Exclude core dumps from git status to prevent accidental commits.
  // Core dumps from crashing binaries (e.g. ESLint custom-rules) pollute the
  // /tmp overlay. Use an absolute path so the rule lands in the actual checkout
  // regardless of cwd, and exec under the home dir for safety.
  const excludeFile = `/${session.homeDir}/${session.repoDir}/.git/info/exclude`;
  await session.runCommand(
    `mkdir -p $(dirname ${bashQuote(excludeFile)}) && echo "core.*" >> ${bashQuote(excludeFile)}`,
    { cwd: `/${session.homeDir}` },
  );
}

export async function setupGitCredentials(
  session: ISandboxSession,
  options: CreateSandboxOptions,
) {
  // Keep credential setup idempotent so hot resumptions don't rewrite secrets when
  // the token is unchanged.
  await session.runCommand(
    'CREDENTIAL_ENTRY="https://${GITHUB_USER_NAME}:${GITHUB_ACCESS_TOKEN}@github.com" && ' +
      'if [ -f ~/.git-credentials ] && grep -Fxq "$CREDENTIAL_ENTRY" ~/.git-credentials; then ' +
      " :; else " +
      'echo "$CREDENTIAL_ENTRY" > ~/.git-credentials; ' +
      "fi && (git config --global credential.helper store 2>/dev/null || true)",
    {
      cwd: "/",
      env: {
        GITHUB_USER_NAME: options.userName,
        GITHUB_ACCESS_TOKEN: options.githubAccessToken,
      },
    },
  );
}

export async function setupSandboxEveryTime({
  session,
  options,
  isCreatingSandbox,
}: {
  session: ISandboxSession;
  options: CreateSandboxOptions;
  isCreatingSandbox: boolean;
}) {
  return await timeSandboxStartupStage(
    "sandbox.setup.every_time",
    {
      ...getSandboxSetupTimingAttrs(options),
      isCreatingSandbox,
      fastResume: Boolean(options.fastResume),
    },
    async () => {
      const shouldProbeSandboxAgent = !options.fastResume || isCreatingSandbox;

      // All setup operations that don't depend on each other run in parallel.
      const parallelOps: Promise<void>[] = [
        setupGitCredentials(session, options),
      ];
      if (shouldProbeSandboxAgent) {
        parallelOps.push(probeSandboxAgentEndpoint({ session, options }));
      }
      const agent = options.agent;
      if (agent && (!options.fastResume || agent === "codex")) {
        parallelOps.push(
          timeSandboxStartupStage(
            "agent.config",
            getSandboxSetupTimingAttrs(options),
            () =>
              updateAgentFiles({
                session,
                customSystemPrompt: options.customSystemPrompt,
                agent,
                agentCredentials: options.agentCredentials,
                skipLocalQualityChecks: options.skipLocalQualityChecks ?? false,
                isCreatingSandbox,
                mcpConfig: options.mcpConfig,
                publicUrl: options.publicUrl,
              }),
          ),
        );
      }
      if (!isCreatingSandbox) {
        if (options.autoUpdateDaemon && !options.fastResume) {
          parallelOps.push(
            (async () => {
              await updateDaemonIfOutdated({ session, options });
              await restartDaemonIfNotRunning({ session, options });
            })(),
          );
        } else {
          parallelOps.push(restartDaemonIfNotRunning({ session, options }));
        }
      }

      await Promise.all(parallelOps);
    },
  );
}

async function updateAgentFilesShared({
  homeDir,
  session,
  agentConfigDir,
  agentCredentialsFilename,
  isCreatingSandbox,
  agentCredentials,
  customSystemPromptFilename,
  customSystemPrompt,
  otherFiles,
}: {
  homeDir: string;
  session: ISandboxSession;
  agentConfigDir: string;
  agentCredentialsFilename: string | null;
  agentCredentials: AIAgentCredentials | null;
  isCreatingSandbox: boolean;
  customSystemPromptFilename: string;
  customSystemPrompt: string | null | undefined;
  otherFiles?: Array<{
    filename: string;
    content: string;
  }>;
}) {
  const configDirAbsolutePath = path.join(homeDir, agentConfigDir);
  const chmodCmds: string[] = [];

  await session.runCommand(`mkdir -p ${configDirAbsolutePath}`, { cwd: "/" });

  if (agentCredentialsFilename) {
    const credentialsPath = path.join(
      configDirAbsolutePath,
      agentCredentialsFilename,
    );
    if (agentCredentials && agentCredentials.type === "json-file") {
      console.log("Writing agent credentials to", credentialsPath);
      await session.writeTextFile(credentialsPath, agentCredentials.contents);
      chmodCmds.push(`chmod 600 ${credentialsPath}`);
    } else if (!isCreatingSandbox) {
      console.log("Removing agent credentials from", credentialsPath);
      await session
        .runCommand(`rm -f ${credentialsPath}`, { cwd: "/" })
        .catch(() => {});
    }
  }

  const customSystemPromptPath = path.join(
    configDirAbsolutePath,
    customSystemPromptFilename,
  );
  if (customSystemPrompt) {
    console.log("Writing custom system prompt to", customSystemPromptPath);
    await session.writeTextFile(customSystemPromptPath, customSystemPrompt);
    chmodCmds.push(`chmod 644 ${customSystemPromptPath}`);
  } else if (!isCreatingSandbox) {
    await session
      .runCommand(`rm -f ${customSystemPromptPath}`, { cwd: "/" })
      .catch(() => {});
  }

  if (otherFiles) {
    for (const file of otherFiles) {
      const filePath = path.join(configDirAbsolutePath, file.filename);
      if (path.dirname(filePath) !== configDirAbsolutePath) {
        const dirPath = path.dirname(filePath);
        console.log("Creating directory", dirPath);
        await session.runCommand(`mkdir -p ${dirPath}`, { cwd: "/" });
      }
      console.log("Writing to", filePath);
      await session.writeTextFile(filePath, file.content);
      chmodCmds.push(`chmod 644 ${filePath}`);
    }
  }

  if (chmodCmds.length > 0) {
    await session.runCommand(chmodCmds.join(" && "), { cwd: "/" });
  }
}

async function updateAgentFiles({
  session,
  agentCredentials,
  customSystemPrompt,
  agent,
  isCreatingSandbox,
  skipLocalQualityChecks,
  mcpConfig,
  publicUrl,
}: {
  session: ISandboxSession;
  agent: AIAgent;
  agentCredentials: AIAgentCredentials | null;
  customSystemPrompt: string | null | undefined;
  isCreatingSandbox: boolean;
  skipLocalQualityChecks: boolean;
  mcpConfig: McpConfig | undefined;
  publicUrl: CreateSandboxOptions["publicUrl"];
}) {
  const homeDir = (await session.runCommand("cd && pwd", { cwd: "/" })).trim();
  switch (agent) {
    case "claudeCode": {
      await ensureClaudeCodeExecutable(session);
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".claude",
        agentCredentialsFilename: ".credentials.json",
        agentCredentials,
        isCreatingSandbox,
        customSystemPromptFilename: "CLAUDE.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "settings.json",
            content: buildClaudeCodeSettings({
              enableStopHook: !skipLocalQualityChecks,
            }),
          },
        ],
      });
      // Write quality check script to /tmp (outside config dir)
      const qualityCheckPath = "/tmp/terragon-quality-check.sh";
      if (skipLocalQualityChecks) {
        await session.runCommand(`rm -f ${qualityCheckPath}`, { cwd: "/" });
      } else {
        await session.writeTextFile(
          qualityCheckPath,
          buildQualityCheckScript(),
        );
        await session.runCommand(`chmod +x ${qualityCheckPath}`, { cwd: "/" });
      }
      break;
    }
    case "codex": {
      let normalizedUrl: string | null = publicUrl ?? null;
      if (normalizedUrl) {
        while (normalizedUrl.endsWith("/") && normalizedUrl.length > 1) {
          normalizedUrl = normalizedUrl.slice(0, -1);
        }
      }
      const terryModelProviderBaseUrl = normalizedUrl
        ? `${normalizedUrl}/api/proxy/openai/v1`
        : null;
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".codex",
        agentCredentialsFilename: "auth.json",
        agentCredentials,
        isCreatingSandbox,
        customSystemPromptFilename: "AGENTS.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "config.toml",
            // Always (re)write Codex MCP config TOML including built-in 'terry' server
            content: buildCodexToml({
              userMcpConfig: mcpConfig,
              includeTerry: true,
              terryCommand: "node",
              terryArgs: [MCP_SERVER_FILE_PATH],
              terryModelProviderBaseUrl,
            }),
          },
        ],
      });
      break;
    }
    case "amp": {
      const ampSettingsContent = buildAmpSettings({
        userMcpConfig: mcpConfig,
      });
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".config",
        agentCredentialsFilename: null,
        agentCredentials: null,
        isCreatingSandbox,
        customSystemPromptFilename: "AGENTS.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "amp/settings.json",
            content: ampSettingsContent,
          },
        ],
      });
      break;
    }
    case "opencode": {
      const opencodeConfigContent = buildOpencodeConfig({
        publicUrl,
        userMcpConfig: mcpConfig,
      });
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".config/opencode",
        agentCredentialsFilename: null,
        agentCredentials: null,
        isCreatingSandbox,
        customSystemPromptFilename: "AGENTS.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "opencode.json",
            content: opencodeConfigContent,
          },
          {
            filename: "plugin/auto-approve.ts",
            content: OPENCODE_AUTO_APPROVE_PLUGIN_CONTENT,
          },
        ],
      });
      break;
    }
    case "gemini": {
      const geminiSettingsContent = buildGeminiSettings({
        userMcpConfig: mcpConfig,
      });
      await updateAgentFilesShared({
        session,
        homeDir,
        agentConfigDir: ".gemini",
        agentCredentialsFilename: null,
        agentCredentials: null,
        isCreatingSandbox,
        customSystemPromptFilename: "GEMINI.md",
        customSystemPrompt,
        otherFiles: [
          {
            filename: "settings.json",
            content: geminiSettingsContent,
          },
        ],
      });
      break;
    }
    default: {
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      break;
    }
  }
}

async function ensureClaudeCodeExecutable(session: ISandboxSession) {
  const command = [
    "set -e",
    'if [ -x /usr/local/bin/claude-real ] && [ -f /usr/bin/claude ] && grep -qs "terragon-claude-wrapper" /usr/bin/claude; then',
    "  claude --version >/tmp/terragon-claude-version.out",
    "  exit 0",
    "fi",
    "if ! claude --version >/tmp/terragon-claude-version.out 2>/tmp/terragon-claude-version.err; then",
    "  if ! grep -Eqi 'exec format|cannot execute binary file' /tmp/terragon-claude-version.err; then cat /tmp/terragon-claude-version.err >&2; exit 1; fi",
    'case "$(node -p process.arch)" in',
    '  x64) claude_platform_package="@anthropic-ai/claude-code-linux-x64" ;;',
    '  arm64) claude_platform_package="@anthropic-ai/claude-code-linux-arm64" ;;',
    '  *) echo "unsupported Claude Code sandbox architecture: $(node -p process.arch)" >&2; exit 1 ;;',
    "esac",
    `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} "$claude_platform_package@${CLAUDE_CODE_VERSION}"`,
    'claude_platform_bin="/usr/lib/node_modules/${claude_platform_package}/claude"',
    'if [ ! -x "$claude_platform_bin" ]; then echo "missing Claude Code platform binary: $claude_platform_bin" >&2; exit 1; fi',
    'ln -sf "$claude_platform_bin" /usr/bin/claude',
    "fi",
    'claude_path=$(readlink -f "$(command -v claude)")',
    'if head -c 2 "$claude_path" | grep -q "^#!"; then',
    `sed -i.bak -e '1a\\
Object.defineProperty(process, "getuid", {\\
  value: function() { return 1000; },\\
  writable: false,\\
  enumerable: true,\\
  configurable: true\\
});' -e 's/![a-zA-Z_$][a-zA-Z0-9_$]*()[.]bypassPermissionsModeAccepted/false/g' "$claude_path"`,
    '  rm -f "$claude_path".bak',
    "fi",
    "id terragon-agent >/dev/null 2>&1 || useradd --create-home --shell /bin/bash terragon-agent",
    "chmod 755 /root",
    'ln -sf "$claude_path" /usr/local/bin/claude-real',
    "rm -f /usr/bin/claude",
    "cat > /usr/bin/claude <<'EOF'",
    "#!/usr/bin/env bash",
    "# terragon-claude-wrapper",
    "set -e",
    'real="/usr/local/bin/claude-real"',
    'if [ "$(id -u)" = "0" ] && id terragon-agent >/dev/null 2>&1; then',
    '  exec env HOME=/root USER=terragon-agent LOGNAME=terragon-agent runuser -u terragon-agent --preserve-environment -- "$real" "$@"',
    "fi",
    'exec "$real" "$@"',
    "EOF",
    "chmod 755 /usr/bin/claude",
    "claude --version >/tmp/terragon-claude-version.out",
  ].join("\n");

  await session.runCommand(command, { cwd: "/" });
}

async function prepareClaudeCodeRunUserWorkspace(
  session: ISandboxSession,
  options: CreateSandboxOptions,
) {
  if (options.agent !== "claudeCode") {
    return;
  }

  const pruneArgs = CLAUDE_WORKSPACE_CHOWN_PRUNES.map(
    (name) => `-name ${bashQuote(name)}`,
  ).join(" -o ");
  await session.runCommand(
    [
      "id terragon-agent >/dev/null 2>&1 || exit 0",
      "chmod 755 /root",
      "chown -R terragon-agent:terragon-agent /root/.claude 2>/dev/null || true",
      `find /root/repo \\( ${pruneArgs} \\) -prune -o -exec chown terragon-agent:terragon-agent {} + 2>/dev/null || true`,
      `find /root/repo -maxdepth 3 \\( ${pruneArgs} \\) -type d -prune -exec chown terragon-agent:terragon-agent {} + 2>/dev/null || true`,
      "git config --global --add safe.directory /root/repo || true",
      "git config --system --add safe.directory /root/repo || true",
    ].join("\n"),
    { cwd: "/" },
  );
}

type OnUpdateCallback = (
  type: "stdout" | "stderr" | "error" | "system",
  output: string,
) => Promise<void> | void;

async function executeSetupScriptCommand({
  session,
  command,
  environmentVariables,
  agentCredentials,
  githubAccessToken,
  onUpdate,
}: {
  session: ISandboxSession;
  command: string;
  environmentVariables: CreateSandboxOptions["environmentVariables"];
  agentCredentials: CreateSandboxOptions["agentCredentials"];
  githubAccessToken: string;
  onUpdate?: OnUpdateCallback;
}) {
  // To debug some corrupted images issue, lets log the git status before and
  // after the setup script runs.
  await session.runCommand("git status");
  await onUpdate?.("system", `Executing setup script...`);
  await onUpdate?.("system", "=".repeat(50));
  const result = await Promise.race([
    (async () => {
      await session.runCommand(command, {
        timeoutMs: terragonSetupScriptTimeoutMs,
        onStdout: (data) => onUpdate?.("stdout", data),
        onStderr: (data) => onUpdate?.("stderr", data),
        env: getEnv({
          userEnv: environmentVariables,
          githubAccessToken,
          agentCredentials,
          overrides: {
            CI: "true",
            TERM: "xterm",
          },
        }),
      });
    })(),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), terragonSetupScriptTimeoutMs),
    ),
  ]);
  if (result === "timeout") {
    throw new Error(
      `Command timed out after ${terragonSetupScriptTimeoutMs}ms`,
    );
  }
  // Log the git status after the setup script runs
  await session.runCommand("git status");
}

const INSTALL_PROGRESS_THROTTLE_MS = 200;

/**
 * Build a throttled install-progress reporter.
 *
 * Returns a `processLine` function to call on each stdout line, and a
 * `flush` function to call once after the command finishes (to emit any
 * final state that was suppressed by the throttle).
 */
export function buildInstallProgressReporter(
  startMs: number,
  onInstallProgress: (
    snapshot: InstallProgressSnapshot,
    elapsedMs: number,
  ) => void,
): {
  processLine: (line: string) => void;
  flush: () => void;
} {
  let accumulated: InstallProgressSnapshot = {
    resolved: 0,
    reused: 0,
    downloaded: 0,
    added: 0,
  };
  let lastEmitMs = 0;
  let hasData = false;

  function emit() {
    const now = Date.now();
    lastEmitMs = now;
    onInstallProgress({ ...accumulated }, now - startMs);
  }

  return {
    processLine(line: string) {
      const update = parsePnpmProgressLine(line);
      if (!update) return;
      hasData = true;

      // Merge partial update into accumulated snapshot.
      if (update.resolved !== undefined) accumulated.resolved = update.resolved;
      if (update.reused !== undefined) accumulated.reused = update.reused;
      if (update.downloaded !== undefined)
        accumulated.downloaded = update.downloaded;
      if (update.added !== undefined) accumulated.added = update.added;
      if (update.total !== undefined) accumulated.total = update.total;
      if (update.currentPackage !== undefined)
        accumulated.currentPackage = update.currentPackage;

      const now = Date.now();
      if (now - lastEmitMs >= INSTALL_PROGRESS_THROTTLE_MS) {
        emit();
      }
    },
    flush() {
      if (hasData) {
        emit();
      }
    },
  };
}

export async function runSetupScript({
  session,
  options,
}: {
  session: ISandboxSession;
  options: Pick<
    CreateSandboxOptions,
    | "environmentVariables"
    | "githubAccessToken"
    | "agentCredentials"
    | "onInstallProgress"
  > & {
    setupScript?: string | null;
    setupScriptPath?: string;
    excludeOutputInError?: boolean;
    onUpdate?: (
      type: "stdout" | "stderr" | "error" | "system",
      output: string,
    ) => Promise<void> | void;
  };
}) {
  const customScriptPath =
    options.setupScriptPath || "/tmp/terragon-setup-custom.sh";
  const outputs: string[] = [];

  const setupStartMs = Date.now();
  const installProgress = options.onInstallProgress
    ? buildInstallProgressReporter(setupStartMs, options.onInstallProgress)
    : null;

  const onUpdateWrapped: OnUpdateCallback = (type, output) => {
    if (type === "stdout" || type === "stderr") {
      outputs.push(output);
    }
    if (type === "stdout" && installProgress) {
      // pnpm emits multi-line chunks; split and process each line.
      for (const line of output.split("\n")) {
        installProgress.processLine(line);
      }
    }
    options.onUpdate?.(type, output);
  };

  try {
    // If a custom setup script is provided, use it instead of checking for terragon-setup.sh
    if (options.setupScript) {
      await options.onUpdate?.(
        "system",
        `Writing setup script to ${customScriptPath}`,
      );
      // Write the custom setup script to a temporary file
      await session.writeTextFile(customScriptPath, options.setupScript);
      await session.runCommand(`chmod +x ${customScriptPath}`);
      await executeSetupScriptCommand({
        session,
        // We know the script path is safe, but mimic the way we invoke the script below for consistency
        command: `bash -c 'if [ -f ${customScriptPath} ]; then chmod +x ${customScriptPath} && bash -x ${customScriptPath}; fi'`,
        environmentVariables: options.environmentVariables,
        agentCredentials: options.agentCredentials,
        githubAccessToken: options.githubAccessToken,
        onUpdate: onUpdateWrapped,
      });
    } else {
      // Use the repository's terragon-setup.sh if it exists
      await executeSetupScriptCommand({
        session,
        command:
          "bash -c 'if [ -f terragon-setup.sh ]; then chmod +x terragon-setup.sh && bash -x ./terragon-setup.sh; fi'",
        environmentVariables: options.environmentVariables,
        agentCredentials: options.agentCredentials,
        githubAccessToken: options.githubAccessToken,
        onUpdate: onUpdateWrapped,
      });
    }
    installProgress?.flush();
    console.log("Setup script output:", outputs.join("\n"));
  } catch (error) {
    // Flush the final install-progress snapshot even on failure so the UI's
    // last visible state reflects what actually happened (not a stale
    // throttle-window value).
    installProgress?.flush();
    // Include the full output in the error message
    let errorMessage = "Setup script failed";
    if (error instanceof Error) {
      // Extract any output that might be in the error message
      errorMessage = `Setup script failed:\n${error.message}`;
    }
    if (!options.excludeOutputInError) {
      errorMessage += "\n\nOutput:\n" + outputs.join("\n");
    }
    throw new Error(errorMessage);
  }
}
