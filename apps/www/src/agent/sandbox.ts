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
import { bashQuote } from "@terragon/sandbox/utils";
import { shouldHibernateSandbox } from "./sandbox-resource";
import { wrapError } from "./error";
import { getPostHogServer } from "@/lib/posthog-server";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { generateBranchName } from "@/server-lib/generate-branch-name";
import { getSetupScriptFromRepo } from "@/server-lib/environment";
import { sandboxTimeoutMs } from "@terragon/sandbox/constants";
import { trackSandboxCreation } from "@/lib/rate-limit";
import { getAndVerifyCredentials } from "./credentials";
import { DEFAULT_SANDBOX_SIZE } from "@/lib/subscription-tiers";
import { ensureAgent } from "@terragon/agent/utils";
import { getLastUserMessageModel } from "@/lib/db-message-helpers";
import type { UserSettings } from "@terragon/shared";
import { redis } from "@/lib/redis";

const SANDBOX_RESUME_CONTEXT_CACHE_PREFIX = "sandbox-resume-context:";
const SANDBOX_RESUME_CONTEXT_CACHE_TTL_SECONDS = 120;

type SandboxResumeMetadataCacheEntry = {
  userSettings: Awaited<ReturnType<typeof getUserSettings>>;
  userFeatureFlags: Awaited<ReturnType<typeof getFeatureFlagsForUser>>;
  repositoryEnvironment: Awaited<ReturnType<typeof getOrCreateEnvironment>>;
};

export type SandboxBranchReconciliationResult = {
  session: ISandboxSession;
  reconciled: boolean;
  restarted: boolean;
  currentBranchName: string | null;
};

function normalizeBranchName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveExpectedBranchForReconciliation(params: {
  createNewBranch: boolean;
  requestedBranchName: string | null | undefined;
  threadBranchName: string | null | undefined;
  repoBaseBranchName: string | null | undefined;
}): string | null {
  const threadBranchName = normalizeBranchName(params.threadBranchName);
  if (threadBranchName) {
    return threadBranchName;
  }

  const requestedBranchName = normalizeBranchName(params.requestedBranchName);
  const repoBaseBranchName = normalizeBranchName(params.repoBaseBranchName);

  if (params.createNewBranch) {
    if (requestedBranchName && requestedBranchName !== repoBaseBranchName) {
      return requestedBranchName;
    }
    return null;
  }

  return requestedBranchName ?? repoBaseBranchName;
}

function getSandboxResumeContextCacheKey({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}) {
  return `${SANDBOX_RESUME_CONTEXT_CACHE_PREFIX}${userId}:${threadId}`;
}

async function getCachedSandboxResumeContext({
  userId,
  threadId,
}: {
  userId: string;
  threadId: string;
}): Promise<SandboxResumeMetadataCacheEntry | null> {
  const cacheKey = getSandboxResumeContextCacheKey({ userId, threadId });
  let raw: unknown = null;
  try {
    raw = await redis.get(cacheKey);
  } catch (error) {
    console.warn("Failed to read sandbox resume context cache", {
      userId,
      threadId,
      error,
    });
    return null;
  }
  if (raw == null) {
    return null;
  }
  if (typeof raw === "object") {
    return raw as SandboxResumeMetadataCacheEntry;
  }
  if (typeof raw !== "string") {
    console.warn("Unexpected sandbox resume context cache payload type", {
      userId,
      threadId,
      type: typeof raw,
    });
    try {
      await redis.del(cacheKey);
    } catch (deleteError) {
      console.warn("Failed to clear sandbox resume context cache", {
        userId,
        threadId,
        deleteError,
      });
    }
    return null;
  }
  try {
    return JSON.parse(raw) as SandboxResumeMetadataCacheEntry;
  } catch (error) {
    console.warn("Failed to parse sandbox resume context cache entry", {
      userId,
      threadId,
      error,
    });
    try {
      await redis.del(cacheKey);
    } catch (deleteError) {
      console.warn("Failed to clear sandbox resume context cache", {
        userId,
        threadId,
        deleteError,
      });
    }
    return null;
  }
}

async function setCachedSandboxResumeContext({
  userId,
  threadId,
  value,
}: {
  userId: string;
  threadId: string;
  value: SandboxResumeMetadataCacheEntry;
}) {
  try {
    await redis.set(
      getSandboxResumeContextCacheKey({ userId, threadId }),
      JSON.stringify(value),
      {
        ex: SANDBOX_RESUME_CONTEXT_CACHE_TTL_SECONDS,
      },
    );
  } catch (error) {
    console.warn("Failed to write sandbox resume context cache", {
      userId,
      threadId,
      error,
    });
  }
}

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

async function readCurrentBranchNameOrNull(
  session: ISandboxSession,
): Promise<string | null> {
  try {
    const branchName = await session.runCommand(
      "git rev-parse --abbrev-ref HEAD",
      {
        cwd: session.repoDir,
      },
    );
    const trimmedBranchName = branchName.trim();
    return trimmedBranchName.length > 0 ? trimmedBranchName : null;
  } catch (error) {
    console.warn("[sandbox] Failed to read current branch name", {
      sandboxId: session.sandboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function checkoutExpectedBranchWithRecovery(params: {
  session: ISandboxSession;
  expectedBranchName: string;
  baseBranchName?: string | null;
}): Promise<string | null> {
  const checkoutCommand = `git checkout ${bashQuote(params.expectedBranchName)}`;

  try {
    await params.session.runCommand(checkoutCommand, {
      cwd: params.session.repoDir,
    });
    const checkedOutBranchName = await readCurrentBranchNameOrNull(
      params.session,
    );
    if (checkedOutBranchName === params.expectedBranchName) {
      return checkedOutBranchName;
    }
  } catch (error) {
    console.warn("[sandbox] Failed to checkout expected branch", {
      sandboxId: params.session.sandboxId,
      repoDir: params.session.repoDir,
      expectedBranchName: params.expectedBranchName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await params.session.runCommand(
      `git fetch origin ${bashQuote(params.expectedBranchName)}:${bashQuote(params.expectedBranchName)}`,
      {
        cwd: params.session.repoDir,
      },
    );
    await params.session.runCommand(checkoutCommand, {
      cwd: params.session.repoDir,
    });
    const fetchedBranchName = await readCurrentBranchNameOrNull(params.session);
    if (fetchedBranchName === params.expectedBranchName) {
      return fetchedBranchName;
    }
  } catch (error) {
    console.warn("[sandbox] Failed to fetch expected branch from origin", {
      sandboxId: params.session.sandboxId,
      repoDir: params.session.repoDir,
      expectedBranchName: params.expectedBranchName,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const baseCandidates = Array.from(
    new Set(
      [params.baseBranchName?.trim(), "main", "master"].filter(
        (candidate): candidate is string => !!candidate && candidate.length > 0,
      ),
    ),
  );

  for (const baseBranchName of baseCandidates) {
    try {
      await params.session.runCommand(
        `git fetch origin ${bashQuote(baseBranchName)}`,
        {
          cwd: params.session.repoDir,
        },
      );
      await params.session.runCommand(
        `git checkout -B ${bashQuote(params.expectedBranchName)} ${bashQuote(`origin/${baseBranchName}`)}`,
        {
          cwd: params.session.repoDir,
        },
      );
      const recreatedBranchName = await readCurrentBranchNameOrNull(
        params.session,
      );
      if (recreatedBranchName === params.expectedBranchName) {
        console.warn("[sandbox] Recreated missing expected branch from base", {
          sandboxId: params.session.sandboxId,
          repoDir: params.session.repoDir,
          expectedBranchName: params.expectedBranchName,
          baseBranchName,
        });
        return recreatedBranchName;
      }
    } catch (error) {
      console.warn("[sandbox] Failed to recreate expected branch from base", {
        sandboxId: params.session.sandboxId,
        repoDir: params.session.repoDir,
        expectedBranchName: params.expectedBranchName,
        baseBranchName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return null;
}

export async function reconcileSandboxBranchForThread(params: {
  session: ISandboxSession;
  expectedBranchName: string | null | undefined;
  baseBranchName?: string | null;
  restartSandbox: () => Promise<ISandboxSession>;
}): Promise<SandboxBranchReconciliationResult> {
  const expectedBranchName = params.expectedBranchName?.trim() ?? "";
  const currentBranchName = await readCurrentBranchNameOrNull(params.session);

  if (!expectedBranchName) {
    return {
      session: params.session,
      reconciled: false,
      restarted: false,
      currentBranchName,
    };
  }

  if (!currentBranchName) {
    console.warn(
      "[sandbox] Skipping branch drift reconciliation: branch unknown",
      {
        sandboxId: params.session.sandboxId,
        repoDir: params.session.repoDir,
        expectedBranchName,
      },
    );
    return {
      session: params.session,
      reconciled: false,
      restarted: false,
      currentBranchName: null,
    };
  }

  if (currentBranchName === expectedBranchName) {
    return {
      session: params.session,
      reconciled: false,
      restarted: false,
      currentBranchName,
    };
  }

  console.warn("[sandbox] Detected branch drift before dispatch", {
    sandboxId: params.session.sandboxId,
    repoDir: params.session.repoDir,
    expectedBranchName,
    currentBranchName,
  });

  const checkedOutBranchName = await checkoutExpectedBranchWithRecovery({
    session: params.session,
    expectedBranchName,
    baseBranchName: params.baseBranchName,
  });
  if (checkedOutBranchName === expectedBranchName) {
    return {
      session: params.session,
      reconciled: true,
      restarted: false,
      currentBranchName: checkedOutBranchName,
    };
  }

  let restartedSession: ISandboxSession;
  try {
    restartedSession = await params.restartSandbox();
  } catch (error) {
    throw wrapError("sandbox-resume-failed", error, "daemon_spawn_failed");
  }
  const restartedBranchName =
    await readCurrentBranchNameOrNull(restartedSession);
  if (restartedBranchName === expectedBranchName) {
    return {
      session: restartedSession,
      reconciled: true,
      restarted: true,
      currentBranchName: restartedBranchName,
    };
  }

  const finalBranchName = await checkoutExpectedBranchWithRecovery({
    session: restartedSession,
    expectedBranchName,
    baseBranchName: params.baseBranchName,
  });
  if (finalBranchName === expectedBranchName) {
    return {
      session: restartedSession,
      reconciled: true,
      restarted: true,
      currentBranchName: finalBranchName,
    };
  }

  throw wrapError(
    "sandbox-resume-failed",
    new Error(
      `Sandbox branch drift could not be reconciled to ${expectedBranchName}`,
    ),
    "daemon_spawn_failed",
  );
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
  const [cachedResumeContext, githubAccessToken] = await Promise.all([
    getCachedSandboxResumeContext({ userId, threadId }),
    getGitHubUserAccessToken({ userId }),
  ]);
  const userFeatureFlags =
    cachedResumeContext?.userFeatureFlags ??
    (await getFeatureFlagsForUser({ db, userId }));
  if (!githubAccessToken) {
    throw new Error("No GitHub access token found");
  }

  const applyAcpTransportDefaults = (
    variables: Array<{ key: string; value: string }>,
  ): Array<{ key: string; value: string }> => {
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
    repositoryEnvironment: Awaited<
      ReturnType<typeof getOrCreateEnvironment>
    > | null;
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
    resolvedSetupScript: string | null;
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
    const [
      resolvedUserSettings,
      resolvedRepositoryEnvironment,
      agentCredentialsOrNull,
    ] = await Promise.all([
      cachedResumeContext?.userSettings ?? getUserSettings({ db, userId }),
      cachedResumeContext?.repositoryEnvironment ??
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
        environmentId: resolvedRepositoryEnvironment.id,
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
        environmentId: resolvedRepositoryEnvironment.id,
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
    const mergedEnvironmentEntries = Object.entries(
      mergedEnvironmentVariables,
    ).map(([key, value]) => ({ key, value }));
    const environmentVariablesHash = hashEnvironmentVariables(
      repositoryEnvironmentVariables,
    );
    const normalizedEnvironmentVariables = applyAcpTransportDefaults(
      mergedEnvironmentEntries,
    );
    const mcpConfigHash = hashSnapshotValue(resolvedMcpConfig);

    const resolvedSetupScript =
      resolvedRepositoryEnvironment.setupScript ??
      (resolvedRepositoryEnvironment.repoFullName && githubAccessToken
        ? await getSetupScriptFromRepo({
            db,
            userId,
            environmentId: resolvedRepositoryEnvironment.id,
          }).catch((err) => {
            console.warn(
              "[sandbox] Could not fetch terragon-setup.sh, skipping:",
              err instanceof Error ? err.message : String(err),
            );
            return null;
          })
        : null);

    if (!cachedResumeContext) {
      await setCachedSandboxResumeContext({
        userId,
        threadId,
        value: {
          userSettings: resolvedUserSettings,
          userFeatureFlags,
          repositoryEnvironment: resolvedRepositoryEnvironment,
        },
      });
    }

    bootstrapContext = {
      repositoryEnvironment: resolvedRepositoryEnvironment,
      agent: agentOrNull,
      agentCredentialsOrNull,
      finalEnvironmentVariables: normalizedEnvironmentVariables,
      environmentVariablesHash,
      mcpConfigHash,
      customSystemPrompt: resolvedUserSettings.customSystemPrompt,
      generateBranchNameWithPrefix: (threadName) =>
        generateBranchName(threadName, resolvedUserSettings.branchNamePrefix),
      mcpConfig: resolvedMcpConfig || undefined,
      resolvedSetupScript,
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

  const buildSandboxOptions = (
    context: BootstrapContext,
  ): CreateSandboxOptions => {
    const shouldAutoSkipSetupInLocalDocker =
      process.env.NODE_ENV === "development" &&
      thread.sandboxProvider === "docker";
    const localDockerPublicUrl = "http://host.docker.internal:3000";
    const resolvedPublicUrl =
      process.env.NODE_ENV === "development" &&
      thread.sandboxProvider === "docker"
        ? localDockerPublicUrl
        : nonLocalhostPublicAppUrl();
    const sandboxSize = thread.sandboxSize ?? DEFAULT_SANDBOX_SIZE;
    const setupScriptHash = getSetupScriptHash(context.resolvedSetupScript);
    const baseDockerfileHash = getSnapshotBaseTemplateId(sandboxSize);
    const snapshot =
      !thread.codesandboxId &&
      thread.sandboxProvider === "daytona" &&
      context.repositoryEnvironment
        ? getReadySnapshot(
            context.repositoryEnvironment,
            "daytona",
            sandboxSize,
            {
              setupScriptHash,
              baseDockerfileHash,
              environmentVariablesHash: context.environmentVariablesHash,
              mcpConfigHash: context.mcpConfigHash,
            },
          )
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
      skipLocalQualityChecks: env.SKIP_LOCAL_QUALITY_CHECKS,
      setupScript: context.resolvedSetupScript,
      // Local docker sandboxes can OOM on monorepo `pnpm install` during first
      // boot; skip setup script by default in local dev unless explicitly needed.
      skipSetupScript: thread.skipSetup || shouldAutoSkipSetupInLocalDocker,
      snapshotTemplateId: snapshot?.snapshotName ?? undefined,
      publicUrl: resolvedPublicUrl,
      featureFlags: userFeatureFlags,
      generateBranchName: context.generateBranchNameWithPrefix,
      onSandboxAllocated: async ({ sandboxId, isCreatingSandbox }) => {
        const updates: { codesandboxId?: string; sandboxSize?: SandboxSize } =
          {};
        if (thread.codesandboxId !== sandboxId) {
          updates.codesandboxId = sandboxId;
        }
        if (thread.sandboxSize !== sandboxSize) {
          updates.sandboxSize = sandboxSize;
        }
        if (Object.keys(updates).length === 0) {
          return;
        }
        try {
          await updateThread({
            db,
            userId,
            threadId,
            updates,
          });
        } catch (error) {
          console.warn(
            "[sandbox] failed to persist allocated sandbox id before setup",
            {
              threadId,
              sandboxId,
              isCreatingSandbox,
              error: error instanceof Error ? error.message : String(error),
            },
          );
          throw error;
        }
      },
      onStatusUpdate: async ({ sandboxId, sandboxStatus, bootingStatus }) => {
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
  const bootstrap = await getBootstrapContext();
  const bootstrapOptions = buildSandboxOptions(bootstrap);
  let session: ISandboxSession;
  try {
    session = await getOrCreateSandboxWithTimeout(thread.codesandboxId, {
      ...bootstrapOptions,
      fastResume: shouldFastResume,
    });
  } catch (error) {
    if (!shouldFastResume) {
      throw error;
    }
    const bootstrapOptions = buildSandboxOptions(bootstrap);
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

  const expectedBranchName = resolveExpectedBranchForReconciliation({
    createNewBranch,
    requestedBranchName: branchName,
    threadBranchName: thread.branchName,
    repoBaseBranchName: thread.repoBaseBranchName,
  });
  const reconciliation = await reconcileSandboxBranchForThread({
    session,
    expectedBranchName,
    baseBranchName: thread.repoBaseBranchName?.trim() || null,
    restartSandbox: () =>
      getOrCreateSandboxWithTimeout(null, {
        ...bootstrapOptions,
        fastResume: false,
      }),
  });
  session = reconciliation.session;
  if (reconciliation.reconciled) {
    console.warn("[sandbox] Branch reconciliation completed before dispatch", {
      threadId,
      sandboxId: session.sandboxId,
      expectedBranchName,
      currentBranchName: reconciliation.currentBranchName,
      restarted: reconciliation.restarted,
    });
  }

  if (
    !thread.codesandboxId ||
    thread.codesandboxId !== session.sandboxId ||
    thread.sandboxSize !== sandboxSize
  ) {
    const updates: {
      codesandboxId?: string;
      sandboxSize: SandboxSize;
      branchName?: string;
    } = {
      sandboxSize,
    };
    if (!thread.codesandboxId || thread.codesandboxId !== session.sandboxId) {
      updates.codesandboxId = session.sandboxId;
    }
    const inferredBranchName =
      createNewBranch && !thread.branchName
        ? normalizeBranchName(reconciliation.currentBranchName)
        : null;
    if (inferredBranchName) {
      updates.branchName = inferredBranchName;
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
      return process.env.NODE_ENV === "development" ? "docker" : "daytona";
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
