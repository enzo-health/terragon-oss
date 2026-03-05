import { CreateSandboxOptions, ISandboxSession } from "./types";
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
import path from "path";

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
  if (!options.featureFlags.sandboxAgentAcpTransport) {
    return;
  }
  const baseUrl = getSandboxAgentBaseUrl(options);
  if (!baseUrl) {
    throw new Error(
      "sandboxAgentAcpTransport is enabled but SANDBOX_AGENT_BASE_URL is missing",
    );
  }
  await ensureSandboxAgentRunning({ session, baseUrl });
  await waitForSandboxAgentHealth({ session, baseUrl });
  try {
    await session.runCommand(`curl -fsS ${bashQuote(`${baseUrl}/v1/acp`)}`, {
      cwd: "/",
    });
    return;
  } catch {
    await session.runCommand(`curl -fsS ${bashQuote(`${baseUrl}/v1/rpc`)}`, {
      cwd: "/",
    });
  }
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
  const dotProfileContents = [
    "ulimit -c 0",
    "if [ -f ~/.bashrc ]; then . ~/.bashrc; fi",
  ].join("\n");
  await session.runCommand(
    `echo ${bashQuote(dotProfileContents)} >> ~/.profile`,
    { cwd: "/" },
  );

  if (!options.snapshotTemplateId) {
    await gitCloneRepo(session, options);
  } else {
    // Repo already cloned in snapshot — just update git remote with fresh token
    await options.onStatusUpdate({
      sandboxId: session.sandboxId,
      sandboxStatus: "booting",
      bootingStatus: "cloning-repo",
    });
    await session.runCommand(
      `git remote set-url origin "https://\${GITHUB_ACCESS_TOKEN}@github.com/${options.githubRepoFullName}.git"`,
      { env: { GITHUB_ACCESS_TOKEN: options.githubAccessToken } },
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
    await session.runCommand(`git checkout ${bashQuote(options.branchName)}`);
  }
  await session.runCommand(`git clean -fxd`);

  await options.onStatusUpdate({
    sandboxId: session.sandboxId,
    sandboxStatus: "booting",
    bootingStatus: "installing-agent",
  });

  const daemonInstallAndProbe = installDaemon({
    session,
    environmentVariables: options.environmentVariables || [],
    githubAccessToken: options.githubAccessToken,
    agentCredentials: options.agentCredentials,
    userMcpConfig: options.mcpConfig,
    publicUrl: options.publicUrl,
    featureFlags: options.featureFlags,
  }).then(() => probeSandboxAgentEndpoint({ session, options }));

  // Only run terragon-setup.sh if not explicitly skipped and no snapshot
  if (options.skipSetupScript || options.snapshotTemplateId) {
    console.log("Skipping setup script (snapshot or explicit skip)");
    await daemonInstallAndProbe;
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
      runSetupScript({
        session,
        options: {
          environmentVariables: options.environmentVariables,
          githubAccessToken: options.githubAccessToken,
          agentCredentials: options.agentCredentials,
          setupScript: options.setupScript,
        },
      }),
    ]);
  }
}

export async function gitCloneRepo(
  session: ISandboxSession,
  options: CreateSandboxOptions,
) {
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
  // All setup operations that don't depend on each other run in parallel.
  const parallelOps: Promise<void>[] = [
    setupGitCredentials(session, options),
    probeSandboxAgentEndpoint({ session, options }),
  ];
  const agent = !options.fastResume ? options.agent : null;
  if (agent) {
    parallelOps.push(
      updateAgentFiles({
        session,
        customSystemPrompt: options.customSystemPrompt,
        agent,
        agentCredentials: options.agentCredentials,
        isCreatingSandbox,
        mcpConfig: options.mcpConfig,
        publicUrl: options.publicUrl,
      }),
    );
  }
  if (!isCreatingSandbox && !options.fastResume) {
    parallelOps.push(
      options.autoUpdateDaemon
        ? (async () => {
            await updateDaemonIfOutdated({ session, options });
            await restartDaemonIfNotRunning({ session, options });
          })()
        : restartDaemonIfNotRunning({ session, options }),
    );
  }

  await Promise.all(parallelOps);
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
  mcpConfig,
  publicUrl,
}: {
  session: ISandboxSession;
  agent: AIAgent;
  agentCredentials: AIAgentCredentials | null;
  customSystemPrompt: string | null | undefined;
  isCreatingSandbox: boolean;
  mcpConfig: McpConfig | undefined;
  publicUrl: CreateSandboxOptions["publicUrl"];
}) {
  const homeDir = (await session.runCommand("cd && pwd", { cwd: "/" })).trim();
  switch (agent) {
    case "claudeCode": {
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
            content: buildClaudeCodeSettings(),
          },
        ],
      });
      // Write quality check script to /tmp (outside config dir)
      const qualityCheckPath = "/tmp/terragon-quality-check.sh";
      await session.writeTextFile(qualityCheckPath, buildQualityCheckScript());
      await session.runCommand(`chmod +x ${qualityCheckPath}`, { cwd: "/" });
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

export async function runSetupScript({
  session,
  options,
}: {
  session: ISandboxSession;
  options: Pick<
    CreateSandboxOptions,
    "environmentVariables" | "githubAccessToken" | "agentCredentials"
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
  const onUpdateWrapped: OnUpdateCallback = (type, output) => {
    if (type === "stdout" || type === "stderr") {
      outputs.push(output);
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
    console.log("Setup script output:", outputs.join("\n"));
  } catch (error) {
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
