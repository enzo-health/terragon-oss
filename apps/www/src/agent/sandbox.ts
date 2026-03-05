import { db } from "@/lib/db";
import { DB } from "@terragon/shared/db";
import { AIAgent, AIModel, AIAgentCredentials } from "@terragon/agent/types";
import {
  getThreadMinimal,
  updateThread,
  getThreadChat,
} from "@terragon/shared/model/threads";
import { getUser, getUserSettings } from "@terragon/shared/model/user";
import { getGitHubUserAccessToken } from "@/lib/github";
import { getFeatureFlagsForUser } from "@terragon/shared/model/feature-flags";
import {
  getOrCreateEnvironment,
  getDecryptedEnvironmentVariables,
  getDecryptedMcpConfig,
  getDecryptedGlobalEnvironmentVariables,
  getReadySnapshot,
  hashEnvironmentVariables,
  hashSnapshotValue,
} from "@terragon/shared/model/environments";
import {
  getSetupScriptHash,
  getSnapshotBaseTemplateId,
} from "@terragon/sandbox/snapshot-builder";
import { env } from "@terragon/env/apps-www";
import type {
  CreateSandboxOptions,
  ISandboxSession,
} from "@terragon/sandbox/types";
import type { SandboxProvider, SandboxSize } from "@terragon/types/sandbox";
import {
  getOrCreateSandbox as getOrCreateSandboxInternal,
  hibernateSandbox as hibernateSandboxInternal,
} from "@terragon/sandbox";
import { shouldHibernateSandbox } from "./sandbox-resource";
import { wrapError } from "./error";
import { getPostHogServer } from "@/lib/posthog-server";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { generateBranchName } from "@/server-lib/generate-branch-name";
import { sandboxTimeoutMs } from "@terragon/sandbox/constants";
import { trackSandboxCreation } from "@/lib/rate-limit";
import { getAndVerifyCredentials } from "./credentials";
import { DEFAULT_SANDBOX_SIZE } from "@/lib/subscription-tiers";
import { ensureAgent } from "@terragon/agent/utils";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import type { UserSettings } from "@terragon/shared";

async function getOrCreateSandboxWithTimeout(
  sandboxId: string | null,
  options: Parameters<typeof getOrCreateSandbox>[1],
) {
  const result = await Promise.race([
    getOrCreateSandbox(sandboxId, options),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => {
        resolve("timeout");
      }, sandboxTimeoutMs),
    ),
  ]);
  if (result === "timeout") {
    throw new Error("Sandbox creation timed out. Please try again later.");
  }
  return result;
}

export async function getSandboxForThreadOrNull({
  db,
  threadId,
  threadChatIdOrNull,
  userId,
  createNewBranch = true,
  branchName,
  fastResume = false,
  onStatusUpdate,
}: {
  db: DB;
  threadId: string;
  threadChatIdOrNull: string | null;
  userId: string;
  createNewBranch?: boolean;
  branchName?: string;
  fastResume?: boolean;
  onStatusUpdate: CreateSandboxOptions["onStatusUpdate"];
}): Promise<ISandboxSession | null> {
  const thread = await getThreadMinimal({ db, threadId, userId });
  if (!thread?.codesandboxId) {
    return null;
  }
  try {
    return await getOrCreateSandboxForThread({
      db,
      threadId,
      threadChatIdOrNull,
      userId,
      createNewBranch,
      branchName,
      fastResume,
      onStatusUpdate,
    });
  } catch (error) {
    getPostHogServer().capture({
      distinctId: userId,
      event: "sandbox_resume_failed",
      properties: {
        threadId,
        sandboxId: thread.codesandboxId,
        sandboxProvider: thread.sandboxProvider,
        githubRepoFullName: thread.githubRepoFullName,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
      },
    });
    throw wrapError("sandbox-resume-failed", error);
  }
}

async function getOrCreateSandboxForThread({
  db,
  threadId,
  threadChatIdOrNull,
  userId,
  onStatusUpdate,
  createNewBranch = true,
  branchName,
  fastResume = false,
}: {
  db: DB;
  threadId: string;
  threadChatIdOrNull: string | null;
  userId: string;
  createNewBranch?: boolean;
  branchName?: string;
  fastResume?: boolean;
  onStatusUpdate: CreateSandboxOptions["onStatusUpdate"];
}): Promise<ISandboxSession> {
  const [user, thread] = await Promise.all([
    getUser({ db, userId }),
    getThreadMinimal({ db, threadId, userId }),
  ]);
  if (!user) {
    throw new Error("User not found");
  }
  if (!thread) {
    throw new Error("Thread not found");
  }
  const shouldFastResume = fastResume && !!thread.codesandboxId;

  let agentOrNull: AIAgent | null = null;
  let modelOrNull: AIModel | null = null;

  const [userFeatureFlags, githubAccessToken] = await Promise.all([
    getFeatureFlagsForUser({ db, userId }),
    getGitHubUserAccessToken({ userId }),
  ]);
  if (!githubAccessToken) {
    throw new Error("No GitHub access token found");
  }

  const applyAcpTransportDefaults = (
    variables: Array<{ key: string; value: string }>,
  ): Array<{ key: string; value: string }> => {
    if (!userFeatureFlags.sandboxAgentAcpTransport) {
      return variables;
    }

    return variables.some(
      (entry) =>
        entry.key === "SANDBOX_AGENT_BASE_URL" && entry.value.trim().length > 0,
    )
      ? variables
      : [
          ...variables.filter(
            (entry) => entry.key !== "SANDBOX_AGENT_BASE_URL",
          ),
          { key: "SANDBOX_AGENT_BASE_URL", value: "http://127.0.0.1:2468" },
        ];
  };

  type BootstrapContext = {
    repositoryEnvironment: Awaited<ReturnType<typeof getOrCreateEnvironment>> | null;
    agent: AIAgent | null;
    agentCredentialsOrNull: AIAgentCredentials | null;
    finalEnvironmentVariables: Array<{ key: string; value: string }>;
    environmentVariablesHash: string;
    mcpConfigHash: string;
    customSystemPrompt: string | null;
    generateBranchNameWithPrefix: (
      threadName: string | null,
    ) => Promise<string | null>;
    mcpConfig: CreateSandboxOptions["mcpConfig"];
  };

  let bootstrapContext: BootstrapContext | null = null;
  const getBootstrapContext = async (): Promise<BootstrapContext> => {
    if (bootstrapContext) {
      return bootstrapContext;
    }

    if (threadChatIdOrNull) {
      const threadChat = await getThreadChat({
        db,
        threadId,
        threadChatId: threadChatIdOrNull,
        userId,
      });
      if (threadChat) {
        agentOrNull = ensureAgent(threadChat.agent);
        modelOrNull = getLastUserMessageModel(threadChat.messages ?? []);
      }
    }
    const [userSettings, repositoryEnvironment, agentCredentialsOrNull] = await Promise.all([
      getUserSettings({ db, userId }),
      getOrCreateEnvironment({
        db,
        userId,
        repoFullName: thread.githubRepoFullName,
      }),
      (async () =>
        agentOrNull
          ? getAndVerifyCredentials({
              agent: agentOrNull,
              model: modelOrNull,
              userId,
            })
          : Promise.resolve(null))(),
    ]);
    const [
      repositoryEnvironmentVariables,
      globalEnvironmentVariables,
      resolvedMcpConfig,
    ] = await Promise.all([
      getDecryptedEnvironmentVariables({
        db,
        userId,
        environmentId: repositoryEnvironment.id,
        encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
      }),
      getDecryptedGlobalEnvironmentVariables({
        db,
        userId,
        encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
      }),
      getDecryptedMcpConfig({
        db,
        userId,
        environmentId: repositoryEnvironment.id,
        encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
      }),
    ]);
    // Merge global and environment-specific variables
    // Environment-specific variables take precedence over global ones
    const mergedEnvironmentVariables = [
      ...globalEnvironmentVariables,
      ...repositoryEnvironmentVariables,
    ].reduce(
      (acc, variable) => {
        acc[variable.key] = variable.value;
        return acc;
      },
      {} as Record<string, string>,
    );
    const mergedEnvironmentEntries = Object.entries(mergedEnvironmentVariables).map(
      ([key, value]) => ({ key, value }),
    );
    const environmentVariablesHash = hashEnvironmentVariables(
      repositoryEnvironmentVariables,
    );
    const normalizedEnvironmentVariables = applyAcpTransportDefaults(
      mergedEnvironmentEntries,
    );
    const mcpConfigHash = hashSnapshotValue(resolvedMcpConfig);

    bootstrapContext = {
      repositoryEnvironment,
      agent: agentOrNull,
      agentCredentialsOrNull,
      finalEnvironmentVariables: normalizedEnvironmentVariables,
      environmentVariablesHash,
      mcpConfigHash,
      customSystemPrompt: userSettings.customSystemPrompt,
      generateBranchNameWithPrefix: (threadName) =>
        generateBranchName(threadName, userSettings.branchNamePrefix),
      mcpConfig: resolvedMcpConfig || undefined,
    };
    return bootstrapContext;
  };

  const isRecoverableSandboxIdError = (error: unknown): boolean => {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return (
      message.includes("sandbox not found") ||
      message.includes("not found") ||
      message.includes("no such sandbox") ||
      message.includes("does not exist")
    );
  };

  const buildSandboxOptions = (context: BootstrapContext): CreateSandboxOptions => {
    const sandboxSize = thread.sandboxSize ?? DEFAULT_SANDBOX_SIZE;
    const setupScriptHash = getSetupScriptHash(context.repositoryEnvironment?.setupScript ?? null);
    const baseDockerfileHash = getSnapshotBaseTemplateId(sandboxSize);
    const snapshot =
      !thread.codesandboxId &&
      thread.sandboxProvider === "daytona" &&
      context.repositoryEnvironment
        ? getReadySnapshot(context.repositoryEnvironment, "daytona", sandboxSize, {
            setupScriptHash,
            baseDockerfileHash,
            environmentVariablesHash: context.environmentVariablesHash,
            mcpConfigHash: context.mcpConfigHash,
          })
        : null;

    return {
      threadName: thread.name,
      agent: context.agent,
      agentCredentials: context.agentCredentialsOrNull,
      userName: user.name,
      userEmail: user.email,
      githubAccessToken,
      githubRepoFullName: thread.githubRepoFullName,
      repoBaseBranchName: thread.repoBaseBranchName,
      userId,
      sandboxProvider: thread.sandboxProvider,
      sandboxSize,
      environmentVariables: context.finalEnvironmentVariables,
      createNewBranch,
      branchName,
      mcpConfig: context.mcpConfig || undefined,
      autoUpdateDaemon: !!userFeatureFlags.autoUpdateDaemon,
      customSystemPrompt: context.customSystemPrompt,
      setupScript: context.repositoryEnvironment?.setupScript || null,
      skipSetupScript: thread.skipSetup,
      snapshotTemplateId: snapshot?.snapshotName ?? undefined,
      publicUrl: nonLocalhostPublicAppUrl(),
      featureFlags: userFeatureFlags,
      generateBranchName: context.generateBranchNameWithPrefix,
      onStatusUpdate: async ({
        sandboxId,
        sandboxStatus,
        bootingStatus,
      }) => {
        if (sandboxId && bootingStatus === "provisioning-done") {
          getPostHogServer().capture({
            distinctId: userId,
            event: "sandbox_provisioned",
            properties: {
              threadId,
              sandboxId,
              sandboxProvider: thread.sandboxProvider,
              githubRepoFullName: thread.githubRepoFullName,
              durationMs: Date.now() - startTime,
            },
          });
        }
        await onStatusUpdate({
          sandboxId,
          sandboxStatus,
          bootingStatus,
        });
      },
    };
  };

  const sandboxSize = thread.sandboxSize ?? DEFAULT_SANDBOX_SIZE;
  const startTime = Date.now();
  const bootstrapContext = await getBootstrapContext();
  let session: ISandboxSession;
  try {
    const bootstrapOptions = buildSandboxOptions(
      bootstrapContext,
    );
    session = await getOrCreateSandboxWithTimeout(thread.codesandboxId, {
      ...bootstrapOptions,
      fastResume: shouldFastResume,
    });
  } catch (error) {
    if (!shouldFastResume) {
      throw error;
    }
    const bootstrapOptions = buildSandboxOptions(bootstrapContext);
    try {
      session = await getOrCreateSandboxWithTimeout(thread.codesandboxId, {
        ...bootstrapOptions,
        fastResume: false,
      });
    } catch (reconcileError) {
      if (!isRecoverableSandboxIdError(reconcileError)) {
        throw reconcileError;
      }
      session = await getOrCreateSandboxWithTimeout(null, {
        ...bootstrapOptions,
        fastResume: false,
      });
    }
  }

  if (
    !thread.codesandboxId ||
    thread.codesandboxId !== session.sandboxId ||
    thread.sandboxSize !== sandboxSize
  ) {
    const updates: {
      codesandboxId?: string;
      sandboxSize: SandboxSize;
    } = {
      sandboxSize,
    };
    if (!thread.codesandboxId || thread.codesandboxId !== session.sandboxId) {
      updates.codesandboxId = session.sandboxId;
    }
    await updateThread({
      db,
      userId,
      threadId,
      updates,
    });
  }
  return session;
}

export async function createSandboxForThread({
  db,
  threadId,
  threadChatIdOrNull,
  userId,
  onStatusUpdate,
  createNewBranch = true,
  branchName,
  fastResume = false,
}: {
  db: DB;
  threadId: string;
  threadChatIdOrNull: string | null;
  userId: string;
  onStatusUpdate: CreateSandboxOptions["onStatusUpdate"];
  createNewBranch?: boolean;
  branchName?: string;
  fastResume?: boolean;
}) {
  try {
    return await getOrCreateSandboxForThread({
      db,
      threadId,
      threadChatIdOrNull,
      userId,
      onStatusUpdate,
      createNewBranch,
      branchName,
      fastResume,
    });
  } catch (error) {
    // Check if this is a setup script failure
    if (
      error instanceof Error &&
      error.message.includes("terragon-setup.sh failed:")
    ) {
      throw wrapError("setup-script-failed", error);
    }
    throw wrapError("sandbox-creation-failed", error);
  }
}

export async function maybeHibernateSandbox({
  userId,
  threadId,
  session,
}: {
  session: ISandboxSession;
  threadId: string;
  userId: string;
}) {
  await maybeHibernateSandboxById({
    userId,
    threadId,
    sandboxId: session.sandboxId,
    sandboxProvider: session.sandboxProvider,
  });
}

export async function maybeHibernateSandboxInternal({
  sandboxId,
  sandboxProvider,
}: {
  sandboxId: string;
  sandboxProvider: SandboxProvider;
}): Promise<boolean> {
  const shouldHibernate = await shouldHibernateSandbox(sandboxId);
  console.log("shouldHibernate", sandboxId, shouldHibernate);
  if (!shouldHibernate) {
    return false;
  }
  await hibernateSandboxInternal({ sandboxProvider, sandboxId });
  return true;
}

export async function maybeHibernateSandboxById({
  userId,
  threadId,
  sandboxId,
  sandboxProvider,
}: {
  userId: string;
  threadId: string;
  sandboxId: string;
  sandboxProvider: SandboxProvider;
}) {
  const didHibernate = await maybeHibernateSandboxInternal({
    sandboxId,
    sandboxProvider,
  });
  if (didHibernate) {
    await updateThread({
      db,
      userId,
      threadId,
      updates: { sandboxStatus: "paused" },
    });
  }
}

export async function getSandboxProvider({
  userSetting,
  sandboxSize,
  userId,
}: {
  userSetting: UserSettings["sandboxProvider"];
  sandboxSize: SandboxSize;
  userId: string;
}): Promise<SandboxProvider> {
  if (process.env.NODE_ENV === "test") {
    return "mock";
  }

  // Check if user has forceDaytonaSandbox feature flag enabled
  const featureFlags = await getFeatureFlagsForUser({ db, userId });
  if (featureFlags.forceDaytonaSandbox) {
    return "daytona";
  }

  switch (userSetting) {
    case "default":
      return "daytona";
    case "e2b":
      return "e2b";
    case "daytona":
      return "daytona";
    case "docker":
      return "docker";
    case "mock":
      return "mock";
    default:
      const _exhaustiveCheck: never = userSetting;
      throw new Error(`Unknown sandbox provider: ${_exhaustiveCheck}`);
  }
}

export async function getOrCreateSandbox(
  sandboxId: string | null,
  options: CreateSandboxOptions,
) {
  if (!sandboxId) {
    await trackSandboxCreation(options.userId);
  }
  const startTime = Date.now();
  try {
    const sandbox = await getOrCreateSandboxInternal(sandboxId, options);
    const duration = Date.now() - startTime;
    // Log sandbox creation or resume time to PostHog
    getPostHogServer().capture({
      distinctId: options.userId,
      event: sandboxId ? "sandbox_resume_time" : "sandbox_creation_time",
      properties: {
        sandboxId: sandbox.sandboxId,
        sandboxProvider: options.sandboxProvider,
        githubRepoFullName: options.githubRepoFullName,
        durationMs: duration,
      },
    });
    return sandbox;
  } catch (error) {
    const duration = Date.now() - startTime;
    // Track sandbox operation failures to PostHog
    getPostHogServer().capture({
      distinctId: options.userId,
      event: sandboxId ? "sandbox_resume_failed" : "sandbox_creation_failed",
      properties: {
        sandboxId: sandboxId || undefined,
        sandboxProvider: options.sandboxProvider,
        githubRepoFullName: options.githubRepoFullName,
        durationMs: duration,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorType:
          error instanceof Error ? error.constructor.name : typeof error,
        isNotFoundError:
          error instanceof Error && error.message.includes("not found"),
      },
    });
    throw error;
  }
}
