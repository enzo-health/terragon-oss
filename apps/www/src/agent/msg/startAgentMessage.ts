import { randomUUID } from "node:crypto";
import { AIAgent, AIModel } from "@terragon/agent/types";
import {
  getDefaultModelForAgent,
  modelRequiresChatGptOAuth,
  modelToAgent,
  normalizedModelForDaemon,
  shouldUseCredits as shouldUseCreditsUtil,
} from "@terragon/agent/utils";
import { gitPullUpstream } from "@terragon/sandbox/commands";
import {
  type BootingSubstatus,
  CreateSandboxOptions,
  ISandboxSession,
} from "@terragon/sandbox/types";
import {
  DBMessage,
  DBUserMessage,
  DBUserMessageWithModel,
  Thread,
} from "@terragon/shared";
import { publishBroadcastUserMessage } from "@terragon/shared/broadcast-server";
import { DB } from "@terragon/shared/db";
import type { AgentRuntimeProvider } from "@terragon/shared/db/types";
import { upsertAgentRunContext } from "@terragon/shared/model/agent-run-context";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  activeThreadStatuses,
  getActiveThreadCount,
  getQueuedThreadCounts,
  getThread,
  getThreadChat,
  updateThread,
  updateThreadChat,
} from "@terragon/shared/model/threads";
import type { ThreadMetaEvent } from "@terragon/shared/runtime/thread-meta-event";
import { waitUntil } from "@vercel/functions";
import { sendDaemonMessage } from "@/agent/daemon";
import { ThreadError } from "@/agent/error";
import {
  type RuntimeAdapterContract,
  resolveImplementationRuntimeAdapter,
} from "@/agent/runtime/implementation-adapter";
import {
  createSandboxForThread,
  getSandboxForThreadOrNull,
} from "@/agent/sandbox";
import { withSandboxResource } from "@/agent/sandbox-resource";
import { handleSlashCommand } from "@/agent/slash-command-handler";
import { withThreadChat } from "@/agent/thread-resource";
import { updateThreadChatWithTransition } from "@/agent/update-status";
import {
  convertToPrompt,
  getLastUserMessageModel,
  getUserMessageToSend,
} from "@/lib/db-message-helpers";
import { getPostHogServer } from "@/lib/posthog-server";
import { uploadUserMessageImages } from "@/lib/r2-file-upload-server";
import { getSandboxCreationRateLimitRemaining } from "@/lib/rate-limit";
import { redis } from "@/lib/redis";
import { getMaxConcurrentTaskCountForUser } from "@/lib/subscription-tiers";
import { formatThreadToMsg } from "@/lib/thread-to-msg-formatter";
import { compactThreadChat, tryAutoCompactThread } from "@/server-lib/compact";
import {
  ensureDispatchRetryPersistenceOwnership,
  maybeProcessFollowUpQueue,
} from "@/server-lib/process-follow-up-queue";
import {
  generateThreadContextResult,
  getThreadContextMessageToGenerate,
} from "@/server-lib/thread-context";
import { getUserCredentials } from "@/server-lib/user-credentials";

const UPSTREAM_PULL_THROTTLE_MS = 5 * 60 * 1000;
const LAST_UPSTREAM_PULL_PREFIX = "thread-last-upstream-pull:";
const FOLLOW_UP_TTFR_START_PREFIX = "follow-up-ttfr-start:";
const FOLLOW_UP_TTFR_START_TTL_SECONDS = 60 * 60;

function getUpstreamPullKey(threadId: string) {
  return `${LAST_UPSTREAM_PULL_PREFIX}${threadId}`;
}

function getFollowUpTtfrStartKey({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  return `${FOLLOW_UP_TTFR_START_PREFIX}${userId}:${threadId}:${threadChatId}`;
}

async function markFollowUpTtfrStart({
  userId,
  threadId,
  threadChatId,
}: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  try {
    await redis.set(
      getFollowUpTtfrStartKey({ userId, threadId, threadChatId }),
      Date.now().toString(),
      { ex: FOLLOW_UP_TTFR_START_TTL_SECONDS },
    );
  } catch (error) {
    console.warn("Failed to write follow-up TTFR start marker", {
      userId,
      threadId,
      threadChatId,
      error,
    });
  }
}

async function shouldPullUpstreamForThread(threadId: string): Promise<boolean> {
  try {
    const key = getUpstreamPullKey(threadId);
    const lockResult = await redis.set(key, Date.now().toString(), {
      nx: true,
      ex: Math.ceil(UPSTREAM_PULL_THROTTLE_MS / 1000),
    });
    return lockResult === "OK";
  } catch (error) {
    console.warn("Failed to read/write upstream pull throttle key", {
      threadId,
      error,
    });
    return true;
  }
}

async function checkTaskQueueLimit({ db, userId }: { db: DB; userId: string }) {
  // Task queue limiting is always enabled
  const queuedCounts = await getQueuedThreadCounts({ db, userId });
  console.log(
    `Task queue limit check - Current queued tasks: ${queuedCounts.queuedTotal}`,
  );
  if (queuedCounts.queuedTotal >= 25) {
    throw new ThreadError(
      "queue-limit-exceeded",
      "You have reached the maximum limit of 25 queued tasks. Please wait for some tasks to complete before adding more.",
      null,
    );
  }
}

function runtimeProviderForDispatch({
  agent,
  adapterId,
}: {
  agent: AIAgent;
  adapterId: RuntimeAdapterContract["adapterId"];
}): AgentRuntimeProvider {
  switch (adapterId) {
    case "codex-app-server":
      return "codex-app-server";
    case "claude-acp":
      return "claude-acp";
    case "legacy": {
      switch (agent) {
        case "claudeCode":
          return "legacy-claude";
        case "gemini":
          return "legacy-gemini";
        case "amp":
          return "legacy-amp";
        case "opencode":
          return "legacy-opencode";
        case "codex":
          return "codex-app-server";
        default: {
          const _exhaustiveCheck: never = agent;
          throw new Error(
            `unsupported legacy runtime provider for ${_exhaustiveCheck}`,
          );
        }
      }
    }
    default: {
      const _exhaustiveCheck: never = adapterId;
      throw new Error(`unsupported runtime adapter ${_exhaustiveCheck}`);
    }
  }
}

export type StartAgentMessageParams = {
  db: DB;
  userId: string;
  // In some cases, the message we want to send to claude is already in the DB.
  // For example, when retrying a thread, we don't want to upload the message again.
  // See also: getUserMessageToSend.
  message?: DBUserMessageWithModel | null;
  threadId: string;
  threadChatId: string;
  isNewThread: boolean;
  createNewBranch?: boolean;
  branchName?: string;
  delayMs?: number;
};

export async function dispatchAgentMessage(
  params: StartAgentMessageParams,
): Promise<StartAgentMessageResult> {
  return startAgentMessage(params);
}

export async function startAgentMessage({
  db,
  userId,
  message,
  threadId,
  threadChatId,
  isNewThread,
  createNewBranch = true,
  branchName,
  delayMs = 0,
}: StartAgentMessageParams): Promise<StartAgentMessageResult> {
  let dispatchLaunched = false;
  console.log("Starting agent message", { threadId, threadChatId });
  if (!isNewThread) {
    await markFollowUpTtfrStart({ userId, threadId, threadChatId });
  }
  if (message) {
    // Check for slash commands
    const slashCommandResult = await handleSlashCommand({
      userId,
      threadId,
      threadChatId,
      message,
    });
    if (slashCommandResult.handled) {
      console.log(`Slash command handled`, {
        threadId,
        threadChatId,
      });
      waitUntil(
        maybeProcessFollowUpQueue({ threadId, userId, threadChatId }).then(
          (result) =>
            ensureDispatchRetryPersistenceOwnership({
              owner: "startAgentMessage",
              userId,
              threadId,
              threadChatId,
              result,
            }),
        ),
      );
      return { dispatchLaunched: false };
    }
  }
  const [userCredentials, acpTransportEnabled] = await Promise.all([
    getUserCredentials({ userId }),
    getFeatureFlagForUser({
      db,
      userId,
      flagName: "sandboxAgentAcpTransport" as never,
    }),
  ]);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await withThreadChat({
    threadId,
    threadChatId,
    userId,
    execOrThrow: async (threadChat) => {
      if (!threadChat) {
        throw new ThreadError("unknown-error", "Thread chat not found", null);
      }
      // Images should be uploaded from the client already but just in case we have old clients,
      // we see if we need to upload anything here.
      const uploadedMessage = message
        ? await uploadUserMessageImages({ userId, message })
        : null;

      // Only check rate limits if the thread doesn't have any active thread chats.
      const thread = await getThread({ db, threadId, userId });
      if (!thread) {
        throw new ThreadError("unknown-error", "Thread not found", null);
      }
      if (
        thread.threadChats.every(
          (chat) => !activeThreadStatuses.includes(chat.status),
        )
      ) {
        const activeThreadCount = await getActiveThreadCount({ db, userId });
        console.log(`Active thread count: ${activeThreadCount}`);
        const [sandboxCreationRateLimitRemaining, maxConcurrentTasks] =
          await Promise.all([
            getSandboxCreationRateLimitRemaining(userId),
            getMaxConcurrentTaskCountForUser(userId),
          ]);
        const sandboxCreationRateLimitReached =
          sandboxCreationRateLimitRemaining.remaining === 0;
        console.log(
          `Sandbox creation rate limit remaining: ${sandboxCreationRateLimitRemaining.remaining}, reset: ${sandboxCreationRateLimitRemaining.reset}`,
        );
        if (activeThreadCount >= maxConcurrentTasks) {
          console.log(`Thread ${threadId}: Max concurrent tasks reached`);

          // Check task queue limit right before we queue the task
          await checkTaskQueueLimit({ db, userId });

          // Log queue metrics when a thread is queued due to concurrency
          const queuedThreadCounts = await getQueuedThreadCounts({
            db,
            userId,
          });
          queuedThreadCounts.queuedTotal++;
          queuedThreadCounts.queuedTasksConcurrency++;
          getPostHogServer().capture({
            distinctId: userId,
            event: "thread_queued",
            properties: {
              threadId,
              reason: "concurrency_limit",
              activeThreadCount,
              maxConcurrentTasks,
              ...queuedThreadCounts,
            },
          });
          await updateThreadChatWithTransition({
            userId,
            threadId,
            threadChatId,
            eventType: "system.concurrency-limit",
            chatUpdates: {
              errorMessage: null,
              errorMessageInfo: null,
              appendMessages: uploadedMessage ? [uploadedMessage] : undefined,
            },
          });
          return;
        }
        if (sandboxCreationRateLimitReached) {
          console.log(
            `Thread ${threadId}: Sandbox creation rate limit reached`,
          );

          // Check task queue limit right before we queue the task
          await checkTaskQueueLimit({ db, userId });

          // Log queue metrics when a thread is queued due to rate limit
          const queuedThreadCounts = await getQueuedThreadCounts({
            db,
            userId,
          });
          getPostHogServer().capture({
            distinctId: userId,
            event: "thread_queued",
            properties: {
              threadId,
              reason: "sandbox_creation_rate_limit",
              rateLimitResetMs: sandboxCreationRateLimitRemaining.reset,
              ...queuedThreadCounts,
            },
          });
          await updateThreadChatWithTransition({
            userId,
            threadId,
            threadChatId,
            eventType: "system.sandbox-creation-rate-limit",
            rateLimitResetTime: sandboxCreationRateLimitRemaining.reset,
            chatUpdates: {
              errorMessage: null,
              errorMessageInfo: null,
              appendMessages: uploadedMessage ? [uploadedMessage] : undefined,
            },
          });
          return;
        }
      }

      // If there's a thread-context message without a thread-context-result message, we need to generate it
      let threadContextPromise: Promise<void> | null = null;
      const threadContextMessage = getThreadContextMessageToGenerate({
        threadChat,
      });
      if (threadContextMessage) {
        threadContextPromise = generateThreadContextResult({
          db,
          userId,
          threadId,
          threadChatId,
          threadContextMessage,
        });
      }

      await updateThreadChatWithTransition({
        userId,
        threadId,
        threadChatId,
        eventType: "system.boot",
        chatUpdates: {
          errorMessage: null,
          errorMessageInfo: null,
          appendMessages: uploadedMessage ? [uploadedMessage] : undefined,
        },
      });
      // Get or create sandbox for the thread
      const startTime = Date.now();
      // We need to provide onStatusUpdate for both new and resumed threads
      // so the UI can show sandbox setup progress (e.g., "Running terragon-setup.sh")

      // Track the last booting substatus transition so we can compute durationMs
      // for the boot.substatus_changed meta event.
      let lastBootingSubstatus: BootingSubstatus | null = null;
      let lastBootingTransitionAt: number | null = null;
      const emitBootSubstatusChanged = (
        nextSubstatus: BootingSubstatus,
        now: number,
      ) => {
        if (nextSubstatus === lastBootingSubstatus) {
          return;
        }
        const durationMs =
          lastBootingTransitionAt !== null
            ? now - lastBootingTransitionAt
            : undefined;
        const metaEvent: ThreadMetaEvent = {
          kind: "boot.substatus_changed",
          threadId,
          from: lastBootingSubstatus,
          to: nextSubstatus,
          timestamp: new Date(now).toISOString(),
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        publishBroadcastUserMessage({
          type: "user",
          id: userId,
          data: {
            threadPatches: [
              {
                threadId,
                op: "upsert",
                metaEvents: [metaEvent],
              },
            ],
          },
        }).catch((error) => {
          console.warn(
            "[start-agent-message] boot.substatus_changed broadcast failed",
            {
              threadId,
              to: nextSubstatus,
              error,
            },
          );
        });
        lastBootingSubstatus = nextSubstatus;
        lastBootingTransitionAt = now;
      };

      const onStatusUpdate: CreateSandboxOptions["onStatusUpdate"] = async ({
        sandboxId,
        sandboxStatus,
        bootingStatus,
      }) => {
        await updateThread({
          db,
          userId,
          threadId,
          updates: {
            sandboxStatus,
            bootingSubstatus: bootingStatus,
          },
        });

        if (bootingStatus !== null) {
          // Normalise `provisioning-done` → `provisioning` so it doesn't
          // appear as a distinct step (mirrors boot-checklist.tsx precedent).
          const normalised: BootingSubstatus =
            bootingStatus === "provisioning-done"
              ? "provisioning"
              : bootingStatus;

          emitBootSubstatusChanged(normalised, Date.now());
        }
      };
      await withSandboxResource({
        // If we're creating a new sandbox, just pass the threadId in as a placeholder.
        sandboxId: thread?.codesandboxId ?? threadId,
        label: "start-claude-message",
        callback: async () => {
          const session = isNewThread
            ? await createSandboxForThread({
                db,
                threadId,
                threadChatIdOrNull: threadChatId,
                userId,
                createNewBranch,
                branchName,
                onStatusUpdate,
              })
            : await getSandboxForThreadOrNull({
                db,
                threadId,
                threadChatIdOrNull: threadChatId,
                userId,
                createNewBranch,
                branchName,
                fastResume: true,
                onStatusUpdate,
              });
          if (!session) {
            throw new ThreadError("sandbox-not-found", "", null);
          }
          getPostHogServer().capture({
            distinctId: userId,
            event: "sandbox_usage_duration",
            properties: {
              threadId,
              label: "start-claude-message",
              sandboxId: session.sandboxId,
              sandboxProvider: session.sandboxProvider,
              durationMs: Date.now() - startTime,
            },
          });
          // Pull latest changes from upstream before sending daemon message
          if (!isNewThread && (await shouldPullUpstreamForThread(threadId))) {
            await gitPullUpstream(session);
          }
          await updateThread({
            db,
            userId,
            threadId,
            updates: {
              bootingSubstatus: "booting-done",
            },
          });
          emitBootSubstatusChanged("booting-done", Date.now());
          if (threadContextPromise) {
            await threadContextPromise;
          }
          threadChat = (await getThreadChat({
            db,
            threadId,
            threadChatId,
            userId,
          }))!;
          // Check if the thread was stopped while we were waiting for the sandbox to boot.
          const updatedThreadStatus = threadChat.status;
          if (
            updatedThreadStatus === "complete" ||
            updatedThreadStatus === "stopping"
          ) {
            console.log(
              `Thread ${threadId}: Sandbox was stopped while we were waiting for it to boot`,
            );
            if (updatedThreadStatus === "stopping") {
              await updateThreadChatWithTransition({
                userId,
                threadId,
                threadChatId,
                eventType: "system.stop",
              });
            }
            return;
          }

          // Pick up any queued messages that were added while we were waiting for the sandbox to boot.
          if (
            threadChat.queuedMessages &&
            threadChat.queuedMessages.length > 0
          ) {
            await updateThreadChat({
              db,
              userId,
              threadId,
              threadChatId,
              updates: {
                appendAndResetQueuedMessages: true,
              },
            });
            threadChat = (await getThreadChat({
              db,
              threadId,
              threadChatId,
              userId,
            }))!;
          }
          let userMessageToSend = getUserMessageToSend({
            messages: threadChat.messages ?? [],
            currentMessage: message ?? null,
          });
          // Update permission mode if it's different from the thread's permission mode
          const newPermissionMode =
            userMessageToSend?.permissionMode ??
            threadChat.permissionMode ??
            "allowAll";
          const currentPermissionMode = threadChat.permissionMode || "allowAll";
          if (newPermissionMode !== currentPermissionMode) {
            await updateThreadChat({
              db,
              userId,
              threadId,
              threadChatId,
              updates: {
                permissionMode: newPermissionMode,
              },
            });
            threadChat = (await getThreadChat({
              db,
              threadId,
              threadChatId,
              userId,
            }))!;
          }
          let sessionId = threadChat.sessionId;
          let codexPreviousResponseId =
            threadChat.codexPreviousResponseId ?? null;
          // If sandbox was just resumed (booting), ACP sessions are dead.
          // Codex app-server sessions are server-side persistent and survive
          // hibernation; daemon falls back to thread/start if session is gone.
          if (threadChat.status === "booting") {
            if (threadChat.agent !== "codex") {
              sessionId = null;
            }
            codexPreviousResponseId = null;
          }
          const { summary, didCompact } = await tryAutoCompactThread({
            userId,
            threadId,
            threadChatId,
          });
          const compactSummarySuffix =
            didCompact && summary
              ? `\n\n---\n\nThe user has run out of context. This is a summary of what has been done: <summary>\n${summary}\n</summary>\n\n`
              : null;
          if (compactSummarySuffix) {
            if (userMessageToSend) {
              userMessageToSend = {
                ...userMessageToSend,
                parts: [
                  ...userMessageToSend.parts,
                  {
                    type: "text",
                    text: compactSummarySuffix,
                  },
                ],
              };
            }
            sessionId = null;
            codexPreviousResponseId = null;
          }
          // Prepare prompt based on model
          const model =
            userMessageToSend?.model ??
            getLastUserMessageModel(threadChat.messages ?? []) ??
            getDefaultModelForAgent({
              agent: threadChat.agent,
              agentVersion: threadChat.agentVersion,
            });

          // Check if the model requires ChatGPT OAuth and user doesn't have it
          if (
            modelRequiresChatGptOAuth(model) &&
            !userCredentials.hasOpenAIOAuthCredentials
          ) {
            throw new ThreadError(
              "chatgpt-sub-required",
              "This model requires a connected ChatGPT subscription.",
              null,
            );
          }

          const agentForModel = modelToAgent(model);
          if (!userMessageToSend) {
            throw new ThreadError("no-user-message", "", null);
          }

          const finalPrompt = userMessageToSend
            ? (
                await preparePromptForModel({
                  model,
                  agent: threadChat.agent,
                  agentVersion: threadChat.agentVersion,
                  userMessageToSend,
                  threadMessages: threadChat.messages ?? [],
                  session,
                })
              ).prompt
            : "";

          const sanitizedPrompt = finalPrompt.replace(
            /(?:^|\s)\/compact(?=\s|$)/g,
            "",
          );
          let finalFinalPrompt = sanitizedPrompt;

          if (threadChat.agent === "codex") {
            const initialTurnStartChars =
              estimateTurnStartRequestSizeChars(finalFinalPrompt);
            console.log("[startAgentMessage] Codex turn/start preflight size", {
              threadId,
              threadChatId,
              chars: initialTurnStartChars,
              softLimit: CODEX_TURN_START_SOFT_INPUT_CHARS,
              hardLimit: CODEX_TURN_START_MAX_INPUT_CHARS,
            });

            if (initialTurnStartChars > CODEX_TURN_START_SOFT_INPUT_CHARS) {
              const forcedCompact = await compactThreadChat({
                userId,
                threadId,
                threadChatId,
              });
              if (forcedCompact?.summary) {
                const compactSummaryMessage: DBMessage = {
                  type: "system",
                  message_type: "compact-result",
                  parts: [{ type: "text", text: forcedCompact.summary }],
                  timestamp: new Date().toISOString(),
                };
                await updateThreadChat({
                  db,
                  userId,
                  threadId,
                  threadChatId,
                  updates: {
                    appendMessages: [compactSummaryMessage],
                    contextLength: null,
                    sessionId: null,
                  },
                });
                finalFinalPrompt =
                  `${finalFinalPrompt}\n\n---\n\n` +
                  `The user has run out of context. This is a summary of what has been done: <summary>\n` +
                  `${forcedCompact.summary}\n</summary>\n\n`;
                sessionId = null;
                codexPreviousResponseId = null;
              }
            }

            const finalTurnStartChars =
              estimateTurnStartRequestSizeChars(finalFinalPrompt);
            if (finalTurnStartChars > CODEX_TURN_START_MAX_INPUT_CHARS) {
              throw new ThreadError(
                "prompt-too-long",
                `Input exceeds the maximum length of ${CODEX_TURN_START_MAX_INPUT_CHARS} characters (estimated=${finalTurnStartChars}).`,
                null,
              );
            }
          }

          if (!finalFinalPrompt.trim()) {
            throw new ThreadError("no-user-message", "", null);
          }

          const shouldUseCredits = shouldUseCreditsUtil(
            agentForModel,
            userCredentials,
          );

          const runId = randomUUID();
          const tokenNonce = randomUUID();
          const rawPermissionMode = threadChat.permissionMode || "allowAll";
          const effectivePermissionMode = rawPermissionMode;
          const implementationDispatch = resolveImplementationRuntimeAdapter(
            threadChat.agent,
          ).createDispatch({
            agent: threadChat.agent,
            agentVersion: threadChat.agentVersion,
            normalizedModel: normalizedModelForDaemon(model),
            prompt: finalFinalPrompt,
            permissionMode: effectivePermissionMode,
            runId,
            sessionId,
            codexPreviousResponseId,
            shouldUseCredits,
            enableAcpTransport: acpTransportEnabled,
          });
          if (
            implementationDispatch.codexPreviousResponseId !==
            codexPreviousResponseId
          ) {
            await updateThreadChat({
              db,
              userId,
              threadId,
              threadChatId,
              updates: {
                codexPreviousResponseId:
                  implementationDispatch.codexPreviousResponseId,
              },
            });
            codexPreviousResponseId =
              implementationDispatch.codexPreviousResponseId;
          }
          const runtimeProvider = runtimeProviderForDispatch({
            agent: threadChat.agent,
            adapterId:
              implementationDispatch.message.runtimeAdapterContract.adapterId,
          });
          const externalSessionId =
            implementationDispatch.message.acpSessionId ??
            implementationDispatch.message.sessionId ??
            null;

          await upsertAgentRunContext({
            db,
            runId,
            userId,
            threadId,
            threadChatId,
            sandboxId: session.sandboxId,
            transportMode: implementationDispatch.transportMode,
            protocolVersion: implementationDispatch.protocolVersion,
            agent: threadChat.agent,
            permissionMode: effectivePermissionMode,
            requestedSessionId: implementationDispatch.requestedSessionId,
            resolvedSessionId: null,
            runtimeProvider,
            externalSessionId,
            previousResponseId: implementationDispatch.codexPreviousResponseId,
            status: "pending",
            tokenNonce,
            daemonTokenKeyId: null,
          });

          try {
            await sendDaemonMessage({
              message: implementationDispatch.message,
              userId,
              threadId,
              threadChatId,
              sandboxId: session.sandboxId,
              session,
              runContext: {
                runId,
                tokenNonce,
                transportMode: implementationDispatch.transportMode,
                protocolVersion: implementationDispatch.protocolVersion,
                agent: threadChat.agent,
              },
            });
            dispatchLaunched = true;
          } catch (dispatchError) {
            console.error(
              `Thread ${threadId}: Daemon dispatch failed after sandbox boot, requeuing`,
              dispatchError,
            );
            await updateThreadChatWithTransition({
              userId,
              threadId,
              threadChatId,
              eventType: "system.concurrency-limit",
              chatUpdates: {
                errorMessage: null,
                errorMessageInfo: null,
              },
            });
            return;
          }
        },
      });
    },
    onError: (error) => {
      console.error("Error starting claude:", error);
    },
  });
  return { dispatchLaunched };
}

export type StartAgentMessageResult = {
  dispatchLaunched: boolean;
};

const CODEX_TURN_START_SOFT_INPUT_CHARS = 900_000;
const CODEX_TURN_START_MAX_INPUT_CHARS = 1_048_576;

function estimateTurnStartRequestSizeChars(prompt: string): number {
  const requestEnvelope = {
    jsonrpc: "2.0",
    id: 1,
    method: "turn/start",
    params: {
      threadId: "thread-id-placeholder",
      input: [{ type: "text", text: prompt }],
      sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" },
    },
  };
  return JSON.stringify(requestEnvelope).length;
}

async function preparePromptForModel({
  model,
  agent,
  agentVersion,
  userMessageToSend,
  threadMessages,
  session,
}: {
  model: AIModel;
  agent: AIAgent;
  agentVersion: number;
  userMessageToSend: DBUserMessage;
  threadMessages: Thread["messages"];
  session: ISandboxSession;
}): Promise<{
  prompt: string;
}> {
  const formatMessageOptions = {
    writeFileBuffer: async ({
      fileName,
      content,
    }: {
      fileName: string;
      content: Buffer;
    }) => {
      await session.writeFile(fileName, content);
      return fileName;
    },
  };

  const promptWithMessageToSendOnly = async () => {
    return convertToPrompt(userMessageToSend, formatMessageOptions);
  };

  const promptWithFullHistory = async () => {
    if (threadMessages && threadMessages.length > 0) {
      return await formatThreadToMsg(threadMessages, formatMessageOptions);
    }
    // No thread history, just format the current message
    return promptWithMessageToSendOnly();
  };

  let prompt: string;
  switch (agent) {
    case "codex": {
      if (agentVersion < 1) {
        prompt = await promptWithFullHistory();
      } else {
        prompt = await promptWithMessageToSendOnly();
      }
      break;
    }
    case "amp":
    case "gemini":
    case "opencode":
    case "claudeCode": {
      prompt = await promptWithMessageToSendOnly();
      break;
    }
    default: {
      const _exhaustiveCheck: never = agent;
      console.warn("Unknown agent", _exhaustiveCheck);
      prompt = await promptWithMessageToSendOnly();
    }
  }
  return { prompt };
}
