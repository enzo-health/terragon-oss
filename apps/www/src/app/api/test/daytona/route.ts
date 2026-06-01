import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getOrCreateSandbox } from "@/agent/sandbox";
import { sendDaemonMessage } from "@/agent/daemon";
import { db } from "@/lib/db";
import { updateThread } from "@terragon/shared/model/threads";
import { upsertAgentRunContext } from "@terragon/shared/model/agent-run-context";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { createThread } from "@terragon/shared/model/threads";
import * as schema from "@terragon/shared/db/schema";
import type { AgentRunStatus } from "@terragon/shared/db/types";
import type { DBUserMessageWithModel } from "@terragon/shared";
import { normalizedModelForDaemon } from "@terragon/agent/utils";
import { AGENT_VERSION } from "@terragon/agent/versions";
import { legacyRuntimeAdapterContract } from "@terragon/daemon/runtime-contracts";
import type {
  BootingSubstatus,
  CreateSandboxOptions,
  SandboxStatus,
} from "@terragon/sandbox/types";
import { nanoid } from "nanoid/non-secure";
import { NextResponse } from "next/server";

const DAYTONA_SMOKE_REPO = "SawyerHood/test-project";
const AGENT_PROOF_FILE = "daytona-agent-proof.txt";
const AGENT_MODEL = "gpt-5.4-mini-low";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAgentPublicUrl(): string {
  const explicit = process.env.DAYTONA_AGENT_PUBLIC_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const localhostPublicDomain = process.env.LOCALHOST_PUBLIC_DOMAIN?.trim();
  if (localhostPublicDomain) {
    return `https://${localhostPublicDomain.replace(/\/+$/, "")}`;
  }
  const fallback = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fallback) {
    return fallback.replace(/\/+$/, "");
  }
  return "http://localhost:3000";
}

async function ensureAgentSmokeUser(userId: string, smokeId: string) {
  const now = new Date();
  await db.insert(schema.user).values({
    id: userId,
    name: "Daytona Agent Smoke",
    email: `${userId}@terragon.local`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.account).values({
    id: `daytona-agent-smoke-github-${smokeId}`,
    accountId: `daytona-agent-smoke-${smokeId}`,
    providerId: "github",
    userId,
    accessToken: process.env.GITHUB_ACCESS_TOKEN ?? "daytona-agent-smoke-token",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.subscription).values({
    id: `daytona-agent-smoke-subscription-${smokeId}`,
    plan: "core",
    status: "active",
    referenceId: userId,
    periodStart: new Date(now.getTime() - 1000 * 60 * 60),
    periodEnd: new Date(now.getTime() + 1000 * 60 * 60),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.userSettings).values({
    userId,
    sandboxProvider: "daytona",
  });
}

async function waitForRunTerminal({
  runId,
  userId,
  timeoutMs,
}: {
  runId: string;
  userId: string;
  timeoutMs: number;
}) {
  const terminalStatuses = new Set<AgentRunStatus>([
    "completed",
    "failed",
    "stopped",
  ]);
  const startedAt = Date.now();
  let lastStatus: AgentRunStatus | null = null;
  while (Date.now() - startedAt < timeoutMs) {
    const runContext = await getAgentRunContextByRunId({ db, runId, userId });
    if (runContext) {
      lastStatus = runContext.status;
      if (terminalStatuses.has(runContext.status)) {
        return runContext;
      }
    }
    await sleep(2_000);
  }
  throw new Error(
    `Timed out waiting for agent run ${runId}; last status was ${lastStatus ?? "missing"}`,
  );
}

async function runAgentSmoke() {
  if (!process.env.HOME) {
    throw new Error("HOME is not set");
  }
  const codexAuthJson = await readFile(
    `${process.env.HOME}/.codex/auth.json`,
    "utf8",
  );

  const smokeId = nanoid();
  const userId = `daytona-agent-smoke-${smokeId}`;
  await ensureAgentSmokeUser(userId, smokeId);

  const proofMarker = `daytona-agent-proof-${smokeId}`;
  const prompt = [
    `Create a file named ${AGENT_PROOF_FILE} in the repository root.`,
    `The file must contain exactly this marker on one line: ${proofMarker}`,
    "Do not commit or push. After writing the file, respond briefly.",
  ].join("\n");
  const initialMessage: DBUserMessageWithModel = {
    type: "user",
    model: AGENT_MODEL,
    permissionMode: "allowAll",
    parts: [{ type: "text", text: prompt }],
    timestamp: new Date().toISOString(),
  };
  const { threadId, threadChatId } = await createThread({
    db,
    userId,
    threadValues: {
      githubRepoFullName: DAYTONA_SMOKE_REPO,
      repoBaseBranchName: "main",
      name: `daytona-agent-smoke-${smokeId}`,
      sandboxProvider: "daytona",
      sandboxSize: "small",
      skipSetup: true,
      disableGitCheckpointing: true,
      sourceType: "www",
      sourceMetadata: { type: "www" },
    },
    initialChatValues: {
      agent: "codex",
      permissionMode: "allowAll",
      status: "booting",
      replaceMessages: [initialMessage],
    },
  });

  const statusUpdates: Array<{
    sandboxId: string | null;
    sandboxStatus: SandboxStatus;
    bootingStatus: BootingSubstatus | null;
  }> = [];
  const startTime = Date.now();
  const sandboxOptions: CreateSandboxOptions = {
    threadName: `daytona-agent-smoke-${smokeId}`,
    userName: "Daytona Agent Smoke",
    userEmail: `${userId}@terragon.local`,
    githubAccessToken: process.env.GITHUB_ACCESS_TOKEN ?? "test-token",
    githubRepoFullName: DAYTONA_SMOKE_REPO,
    repoBaseBranchName: "main",
    userId,
    sandboxProvider: "daytona",
    sandboxSize: "small",
    agent: "codex",
    agentCredentials: {
      type: "json-file",
      contents: codexAuthJson,
    },
    createNewBranch: true,
    environmentVariables: [{ key: "DAYTONA_AGENT_SMOKE", value: smokeId }],
    autoUpdateDaemon: false,
    skipLocalQualityChecks: true,
    skipSetupScript: true,
    publicUrl: getAgentPublicUrl(),
    featureFlags: {},
    generateBranchName: async () => `terragon/daytona-agent-smoke-${smokeId}`,
    onSandboxAllocated: async ({ sandboxId }) => {
      await updateThread({
        db,
        userId,
        threadId,
        updates: { codesandboxId: sandboxId },
      });
    },
    onStatusUpdate: async (update) => {
      statusUpdates.push(update);
      await updateThread({
        db,
        userId,
        threadId,
        updates: {
          sandboxStatus: update.sandboxStatus,
          bootingSubstatus: update.bootingStatus,
        },
      });
    },
  };

  const sandbox = await getOrCreateSandbox(null, sandboxOptions);
  try {
    const runId = randomUUID();
    const tokenNonce = randomUUID();
    await upsertAgentRunContext({
      db,
      runId,
      userId,
      threadId,
      threadChatId,
      sandboxId: sandbox.sandboxId,
      transportMode: "legacy",
      protocolVersion: 1,
      agent: "codex",
      permissionMode: "allowAll",
      requestedSessionId: null,
      resolvedSessionId: null,
      runtimeProvider: null,
      externalSessionId: null,
      previousResponseId: null,
      status: "pending",
      tokenNonce,
      daemonTokenKeyId: null,
    });

    await sendDaemonMessage({
      userId,
      threadId,
      threadChatId,
      sandboxId: sandbox.sandboxId,
      session: sandbox,
      runContext: {
        runId,
        tokenNonce,
        transportMode: "legacy",
        protocolVersion: 1,
        agent: "codex",
        codexOAuthCredentialId: null,
      },
      message: {
        type: "claude",
        prompt,
        model: normalizedModelForDaemon(AGENT_MODEL),
        agent: "codex",
        agentVersion: AGENT_VERSION,
        sessionId: null,
        codexPreviousResponseId: null,
        permissionMode: "allowAll",
        useCredits: false,
        runId,
        transportMode: "legacy",
        protocolVersion: 1,
        runtimeAdapterContract: legacyRuntimeAdapterContract,
      },
    });

    const processSample = await sandbox.runCommand(
      "ps -eo pid,comm,args | grep -E 'terragon-daemon|codex' | grep -v grep || true",
      { cwd: "/", timeoutMs: 10_000 },
    );
    const terminalRunContext = await waitForRunTerminal({
      runId,
      userId,
      timeoutMs: 240_000,
    });
    const proofFile = await sandbox.runCommand(`cat ${AGENT_PROOF_FILE}`, {
      cwd: sandbox.repoDir,
      timeoutMs: 10_000,
    });
    const gitStatus = await sandbox.runCommand("git status --short", {
      cwd: sandbox.repoDir,
      timeoutMs: 10_000,
    });

    return NextResponse.json({
      ok:
        terminalRunContext.status === "completed" &&
        proofFile.trim() === proofMarker,
      mode: "agent",
      sandboxId: sandbox.sandboxId,
      threadId,
      threadChatId,
      runId,
      runStatus: terminalRunContext.status,
      elapsedMs: Date.now() - startTime,
      proofFile,
      proofMarker,
      gitStatus,
      processSample,
      statusUpdates,
    });
  } finally {
    await sandbox.shutdown().catch((error) => {
      console.error("[daytona-agent-smoke] failed to shutdown sandbox", error);
    });
  }
}

export async function GET(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    throw new Error("This endpoint is only available in development");
  }
  if (!process.env.DAYTONA_API_KEY?.trim()) {
    throw new Error("DAYTONA_API_KEY is not set");
  }
  const url = new URL(request.url);
  if (url.searchParams.get("mode") === "agent") {
    return runAgentSmoke();
  }

  const smokeId = nanoid();
  const statusUpdates: Array<{
    sandboxId: string | null;
    sandboxStatus: SandboxStatus;
    bootingStatus: BootingSubstatus | null;
  }> = [];
  const startTime = Date.now();
  const sandboxOptions: CreateSandboxOptions = {
    threadName: `daytona-smoke-${smokeId}`,
    userName: "Daytona Smoke",
    userEmail: "daytona-smoke@terragon.local",
    githubAccessToken: process.env.GITHUB_ACCESS_TOKEN ?? "test-token",
    githubRepoFullName: DAYTONA_SMOKE_REPO,
    repoBaseBranchName: "main",
    userId: `daytona-smoke-${smokeId}`,
    sandboxProvider: "daytona",
    sandboxSize: "small",
    agent: null,
    agentCredentials: null,
    createNewBranch: true,
    environmentVariables: [{ key: "DAYTONA_APP_SMOKE", value: smokeId }],
    autoUpdateDaemon: false,
    skipLocalQualityChecks: true,
    skipSetupScript: true,
    publicUrl: getAgentPublicUrl(),
    featureFlags: {},
    generateBranchName: async () => `terragon/daytona-smoke-${smokeId}`,
    onStatusUpdate: async (update) => {
      statusUpdates.push(update);
    },
  };

  const sandbox = await getOrCreateSandbox(null, sandboxOptions);
  try {
    const commandOutput = await sandbox.runCommand(
      [
        "set -euo pipefail",
        'printf "provider=daytona\\n"',
        'printf "smoke=$DAYTONA_APP_SMOKE\\n"',
        'printf "repo=" && git -C /root/repo rev-parse --is-inside-work-tree',
        'test -f /tmp/terragon-daemon.mjs && printf "daemon=present\\n"',
      ].join("\n"),
      { cwd: "/", timeoutMs: 30_000 },
    );
    return NextResponse.json({
      ok: true,
      sandboxId: sandbox.sandboxId,
      elapsedMs: Date.now() - startTime,
      commandOutput,
      statusUpdates,
    });
  } finally {
    await sandbox.shutdown().catch((error) => {
      console.error("[daytona-smoke] failed to shutdown sandbox", error);
    });
  }
}
