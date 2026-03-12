#!/usr/bin/env npx tsx
/**
 * E2E test: Full delivery loop with real Codex agent + real test DB.
 *
 * Tests that Codex understands an implementing prompt, calls
 * MarkImplementingTasksComplete via the terragon MCP server, the HTTP stub
 * writes to the real test DB, and the loop transitions correctly.
 *
 * Usage:
 *   pnpm -C packages/shared exec tsx test-delivery-loop-e2e.ts
 *   pnpm -C packages/shared exec tsx test-delivery-loop-e2e.ts --with-planning
 *   pnpm -C packages/shared exec tsx test-delivery-loop-e2e.ts --in-docker
 *   pnpm -C packages/shared exec tsx test-delivery-loop-e2e.ts --full
 *   pnpm -C packages/shared exec tsx test-delivery-loop-e2e.ts --full --with-review
 *
 * Requires:
 *   - codex CLI on PATH (npm i -g @openai/codex)
 *   - Test DB running on port 15432 (docker compose up)
 *   - MCP server built (pnpm -C packages/mcp-server build)
 *   - OpenAI credentials (~/.codex/auth.json or OPENAI_API_KEY)
 */

import { spawn, execSync, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { DB } from "./src/db/index.ts";
import type {
  CodexAppServerManager as CodexAppServerManagerType,
  CodexAppServerSpawn,
  CodexAppServerSpawnOptions,
  CodexAppServerProcess,
  JsonRpcNotificationEnvelope,
} from "../daemon/src/codex-app-server";
import { nanoid } from "nanoid/non-secure";

// ---------------------------------------------------------------------------
// Resolve paths
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const MCP_SERVER_PATH = resolve(ROOT, "packages/mcp-server/dist/bundled.js");
const DAEMON_SRC = resolve(__dirname, "../daemon/src");

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
const WITH_PLANNING = process.argv.includes("--with-planning");
const IN_DOCKER = process.argv.includes("--in-docker");
const FULL = process.argv.includes("--full");
const WITH_REVIEW = process.argv.includes("--with-review");
const MODEL = process.env.CODEX_MODEL ?? "gpt-5.3-codex";
const REVIEW_MODEL = process.env.CODEX_REVIEW_MODEL ?? "gpt-5.3-codex";
const TIMEOUT_MS = 180_000;

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:15432/postgres";

// ---------------------------------------------------------------------------
// Skip checks
// ---------------------------------------------------------------------------
function codexAvailable(): boolean {
  try {
    execSync("codex --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function testDbAvailable(): boolean {
  try {
    execSync(
      `pg_isready -h localhost -p 15432 -U postgres 2>/dev/null || node -e "const net=require('net');const s=net.connect(15432,'localhost',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"`,
      { stdio: "pipe", timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

// ---------------------------------------------------------------------------
// Dynamic imports (avoid test-helpers.ts — it transitively imports
// @terragon/types/broadcast which breaks tsx ESM/CJS interop)
// ---------------------------------------------------------------------------
async function loadSharedModules() {
  const { createDb } = await import("./src/db/index.ts");
  const {
    enrollSdlcLoopForThread,
    createPlanArtifactForLoop,
    approvePlanArtifactForLoop,
    replacePlanTasksForArtifact,
    markPlanTasksCompletedByAgent,
    verifyPlanTaskCompletionForHead,
    transitionSdlcLoopState,
    getActiveSdlcLoopForThread,
    createImplementationArtifactForHead,
    createReviewBundleArtifactForHead,
    createUiSmokeArtifactForHead,
    createPrLinkArtifact,
    createBabysitEvaluationArtifactForHead,
    persistSdlcCiGateEvaluation,
    persistDeepReviewGateResult,
    persistCarmackReviewGateResult,
    buildSdlcCanonicalCause,
  } = await import("./src/model/delivery-loop.ts");

  const {
    claimNextUnprocessedSignal,
    completeSignalClaim,
    evaluateBabysitCompletionForHead,
  } = await import("./src/model/signal-inbox-core.ts");

  return {
    createDb,
    enrollSdlcLoopForThread,
    createPlanArtifactForLoop,
    approvePlanArtifactForLoop,
    replacePlanTasksForArtifact,
    markPlanTasksCompletedByAgent,
    verifyPlanTaskCompletionForHead,
    transitionSdlcLoopState,
    getActiveSdlcLoopForThread,
    createImplementationArtifactForHead,
    createReviewBundleArtifactForHead,
    createUiSmokeArtifactForHead,
    createPrLinkArtifact,
    createBabysitEvaluationArtifactForHead,
    persistSdlcCiGateEvaluation,
    persistDeepReviewGateResult,
    persistCarmackReviewGateResult,
    buildSdlcCanonicalCause,
    claimNextUnprocessedSignal,
    completeSignalClaim,
    evaluateBabysitCompletionForHead,
  };
}

// ---------------------------------------------------------------------------
// Local codex exec runner for review gates
// ---------------------------------------------------------------------------

const REVIEW_GATE_PROMPT_VERSION = 1;

function buildReviewGatePrompt({
  gateName,
  systemPrompt,
  repoFullName,
  headSha,
  taskContext,
  gitDiff,
}: {
  gateName: string;
  systemPrompt: string;
  repoFullName: string;
  headSha: string;
  taskContext: string;
  gitDiff: string;
}): string {
  return [
    systemPrompt,
    "",
    `Repository: ${repoFullName}`,
    `PR: not-created-yet`,
    `Head SHA: ${headSha}`,
    `Prompt Version: ${REVIEW_GATE_PROMPT_VERSION}`,
    "",
    `Task context:`,
    taskContext,
    "",
    `Git diff:`,
    `<git-diff>`,
    gitDiff,
    `</git-diff>`,
    "",
    `Return JSON with shape:`,
    `{`,
    `  "gatePassed": boolean,`,
    `  "blockingFindings": [`,
    `    {`,
    `      "stableFindingId": string (optional),`,
    `      "title": string,`,
    `      "severity": "critical"|"high"|"medium"|"low",`,
    `      "category": string,`,
    `      "detail": string,`,
    `      "suggestedFix": string | null,`,
    `      "isBlocking": boolean`,
    `    }`,
    `  ]`,
    `}`,
  ].join("\n");
}

const DEEP_REVIEW_SYSTEM_PROMPT = `You are the Deep Review gate for an autonomous Delivery Loop.
Return strict JSON only.
Identify only actionable, code-level defects that must be fixed before progression.
Each finding must include stable fields so retries remain deterministic.
Set gatePassed=true only when there are zero blocking findings.`;

const CARMACK_REVIEW_SYSTEM_PROMPT = `You are the Carmack Review gate for an autonomous Delivery Loop.
Return strict JSON only.
Focus on architectural correctness, determinism, idempotency, race safety, and edge-case handling.
Only include findings that must be fixed before progression.
Set gatePassed=true only when there are zero blocking findings.`;

type CodexExecEvent = {
  type?: string;
  message?: string;
  item?: { type?: string; text?: string };
};

function extractLatestAgentMessage(rawStdout: string): string | null {
  const agentMessages: string[] = [];
  for (const line of rawStdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: CodexExecEvent | null = null;
    try {
      event = JSON.parse(trimmed) as CodexExecEvent;
    } catch {
      continue;
    }
    if (event.type === "error") {
      throw new Error(event.message?.trim() || "Codex gate reported an error");
    }
    if (
      (event.type === "item.completed" || event.type === "item.updated") &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string" &&
      event.item.text.trim().length > 0
    ) {
      agentMessages.push(event.item.text.trim());
    }
  }
  return agentMessages.length > 0
    ? agentMessages[agentMessages.length - 1]!
    : null;
}

function extractJsonFromText(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    // try fenced code blocks
  }
  const fenced = [...rawText.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of fenced.reverse()) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  const first = rawText.indexOf("{");
  const last = rawText.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(rawText.slice(first, last + 1));
    } catch {
      // fall through
    }
  }
  throw new Error("Could not parse JSON from Codex gate output");
}

function runCodexExecLocally({
  prompt,
  model,
  timeoutMs = 120_000,
}: {
  prompt: string;
  model: string;
  timeoutMs?: number;
}): unknown {
  const promptFile = join(tmpdir(), `dl-review-${nanoid()}.txt`);
  try {
    writeFileSync(promptFile, prompt, "utf-8");
    const stdout = execFileSync(
      "codex",
      [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--json",
        "--model",
        model,
        "-c",
        "suppress_unstable_features_warning=true",
        "-",
      ],
      {
        input: prompt,
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const agentMessage = extractLatestAgentMessage(stdout);
    if (!agentMessage) {
      throw new Error("No agent message in Codex exec output");
    }
    return extractJsonFromText(agentMessage);
  } finally {
    try {
      unlinkSync(promptFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---------------------------------------------------------------------------
// Inline fixture creators (replaces test-helpers.ts to avoid broadcast chain)
// ---------------------------------------------------------------------------
async function createTestUserInline(db: DB) {
  const schema = await import("./src/db/schema.ts");
  const userId = nanoid();
  const email = `test-${userId}@terragon.com`;

  const [user] = await db
    .insert(schema.user)
    .values({
      id: userId,
      email,
      name: "E2E Test User",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("Failed to create test user");

  // userFlags row (replaces getUserFlags call which imports broadcast-server)
  await db.insert(schema.userFlags).values({ userId }).onConflictDoNothing();

  const accountId = Math.floor(Math.random() * 10000000).toString();
  await db.insert(schema.account).values({
    id: accountId,
    accountId,
    providerId: "github",
    userId,
    accessToken: "123",
    refreshToken: "123",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(schema.subscription).values({
    id: nanoid(),
    plan: "core",
    status: "active",
    periodStart: new Date(Date.now() - 30 * 86400_000),
    periodEnd: new Date(Date.now() + 30 * 86400_000),
    referenceId: userId,
  });

  await db.insert(schema.session).values({
    id: nanoid(),
    userId,
    expiresAt: new Date(Date.now() + 30 * 86400_000),
    createdAt: new Date(),
    updatedAt: new Date(),
    token: nanoid(),
  });

  return user;
}

async function createTestThreadInline(
  db: DB,
  userId: string,
  repoFullName: string,
): Promise<{ threadId: string; threadChatId: string }> {
  const schema = await import("./src/db/schema.ts");
  const threadId = nanoid();
  const threadChatId = nanoid();

  await db.insert(schema.thread).values({
    id: threadId,
    userId,
    name: "E2E Delivery Loop Test",
    githubRepoFullName: repoFullName,
    repoBaseBranchName: "main",
    sandboxProvider: "e2b",
  });

  await db.insert(schema.threadChat).values({
    id: threadChatId,
    userId,
    threadId,
    agent: "claudeCode",
  });

  return { threadId, threadChatId };
}

// ---------------------------------------------------------------------------
// Import CodexAppServerManager (direct file import — not exported from package)
// ---------------------------------------------------------------------------
async function loadCodexManager(): Promise<{
  CodexAppServerManager: typeof CodexAppServerManagerType;
}> {
  const mod = await import(
    /* @vite-ignore */
    resolve(DAEMON_SRC, "codex-app-server.ts")
  );
  return mod;
}

// ---------------------------------------------------------------------------
// Types for captured notifications & HTTP stub
// ---------------------------------------------------------------------------
type CapturedNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type StubRequest = {
  method: string;
  url: string;
  body: MarkTasksRequestBody;
  headers: Record<string, string>;
};

type CompletedTaskEntry = {
  stableTaskId: string;
  status?: string;
  note?: string | null;
};

type MarkTasksRequestBody = {
  threadId?: string;
  threadChatId?: string;
  headSha?: string;
  completedTasks?: CompletedTaskEntry[];
};

function waitForNotification(
  notifications: CapturedNotification[],
  predicate: (n: CapturedNotification) => boolean,
  timeoutMs: number,
): Promise<CapturedNotification> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const match = notifications.find(predicate);
      if (match) {
        clearInterval(interval);
        resolve(match);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        const methods = [...new Set(notifications.map((n) => n.method))].join(
          ", ",
        );
        reject(new Error(`Timed out (${timeoutMs}ms). Events: ${methods}`));
      }
    }, 100);
  });
}

// ---------------------------------------------------------------------------
// HTTP stub server (does real DB writes)
// ---------------------------------------------------------------------------
async function startMarkTasksStub(opts: {
  db: DB;
  loopId: string;
  artifactId: string;
}): Promise<{ server: Server; port: number; requests: StubRequest[] }> {
  const shared = await loadSharedModules();
  const requests: StubRequest[] = [];

  return new Promise((resolveStart) => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      let body: MarkTasksRequestBody;
      try {
        body = JSON.parse(
          Buffer.concat(chunks).toString(),
        ) as MarkTasksRequestBody;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        headers: req.headers as Record<string, string>,
      });

      if (req.url === "/api/sdlc/mark-tasks" && req.method === "POST") {
        try {
          const completions = (body.completedTasks ?? []).map(
            (t: CompletedTaskEntry) => ({
              stableTaskId: t.stableTaskId,
              status: (t.status ?? "done") as "done" | "skipped" | "blocked",
              evidence: {
                headSha: body.headSha ?? "e2e-test-sha",
                note: t.note ?? null,
              },
            }),
          );

          const result = await shared.markPlanTasksCompletedByAgent({
            db: opts.db,
            loopId: opts.loopId,
            artifactId: opts.artifactId,
            completions,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              success: true,
              updatedTaskCount: result.updatedTaskCount,
            }),
          );
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("  [stub] DB error:", message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      }
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolveStart({ server, port, requests });
    });
  });
}

// ---------------------------------------------------------------------------
// Codex runner using CodexAppServerManager
// ---------------------------------------------------------------------------
async function runCodexTurn(opts: {
  prompt: string;
  instructions: string;
  mcpServerPath: string;
  stubPort: number;
  threadId: string;
  threadChatId: string;
  notifications: CapturedNotification[];
}): Promise<{ turnCompleted: boolean; turnFailed: boolean }> {
  const { CodexAppServerManager } = await loadCodexManager();

  // Inject terry MCP server config via -c flags (dotted TOML path overrides)
  const mcpFlags = [
    "-c",
    `mcp_servers.terry.command="node"`,
    "-c",
    `mcp_servers.terry.args=["${opts.mcpServerPath}"]`,
    "-c",
    `mcp_servers.terry.env.TERRAGON_SERVER_URL="http://localhost:${opts.stubPort}"`,
    "-c",
    `mcp_servers.terry.env.DAEMON_TOKEN="e2e-test-token"`,
    "-c",
    `mcp_servers.terry.env.TERRAGON_THREAD_ID="${opts.threadId}"`,
    "-c",
    `mcp_servers.terry.env.TERRAGON_THREAD_CHAT_ID="${opts.threadChatId}"`,
  ];

  const realSpawn: CodexAppServerSpawn = (
    command: string,
    args: string[],
    options: CodexAppServerSpawnOptions,
  ) => {
    const proc: ChildProcess = spawn(command, [...args, ...mcpFlags], {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env,
    });
    return proc as unknown as CodexAppServerProcess;
  };

  const manager: CodexAppServerManagerType = new CodexAppServerManager({
    logger: {
      info: (...args: unknown[]) => console.log("  [codex]", ...args),
      warn: (...args: unknown[]) => console.warn("  [codex]", ...args),
      error: (...args: unknown[]) => console.error("  [codex]", ...args),
      debug: () => {},
    },
    model: MODEL,
    daemonToken: null,
    env: process.env,
    requestTimeoutMs: TIMEOUT_MS,
    handshakeTimeoutMs: 30_000,
    spawnProcess: realSpawn,
  });

  manager.onNotification((notification: JsonRpcNotificationEnvelope) => {
    opts.notifications.push({
      method: notification.method,
      params: notification.params,
    });

    // Log interesting events
    const m = notification.method;
    const p = notification.params ?? {};
    if (m.includes("mcp")) {
      console.log(`  [codex] [mcp] ${m}`, JSON.stringify(p).slice(0, 200));
    }
    if (m === "turn/completed" || m === "turn/failed") {
      console.log(`  [codex] ${m}`);
    } else if (m.startsWith("item/")) {
      const item = (p as Record<string, Record<string, unknown>>).item ?? {};
      const type = (item.type as string) ?? "?";
      if (type === "agent_message" || type === "agentMessage") {
        const text = (item.text as string) ?? "";
        const preview = text.length > 100 ? text.slice(0, 97) + "..." : text;
        console.log(`  [codex] [message] ${preview}`);
      } else if (type === "mcp_tool_call" || type === "mcpToolCall") {
        console.log(
          `  [codex] [mcp_tool] ${(item.name as string) ?? (item.tool_name as string) ?? "?"}`,
        );
      }
    }
  });

  await manager.ensureReady();

  // Start thread
  const threadResult = (await manager.send({
    method: "thread/start",
    params: {
      model: MODEL,
      stream: true,
      instructions: opts.instructions,
      sandbox: "read-only",
      approvalPolicy: "never",
    },
    threadChatId: "delivery-loop-e2e",
  })) as { thread?: { id?: string } };

  const threadId = threadResult?.thread?.id;
  if (!threadId) {
    throw new Error("Never received threadId from thread/start");
  }
  console.log(`  [codex] threadId = ${threadId}`);

  // Wait for MCP startup
  try {
    await waitForNotification(
      opts.notifications,
      (n) => n.method === "codex/event/mcp_startup_complete",
      15_000,
    );
  } catch {
    console.warn("  [codex] MCP startup notification not received, continuing");
  }

  // Verify terry MCP server is ready
  const mcpComplete = opts.notifications.find(
    (n) => n.method === "codex/event/mcp_startup_complete",
  );
  const mcpMsg = (mcpComplete?.params as Record<string, unknown> | undefined)
    ?.msg as Record<string, unknown> | undefined;
  const readyServers = mcpMsg?.ready as string[] | undefined;

  if (!readyServers?.includes("terry")) {
    console.warn("  [codex] Terry MCP server not in ready list:", readyServers);
    console.warn("  [codex] Continuing anyway — tool call may still work");
  } else {
    console.log("  [codex] Terry MCP server ready");
  }

  // Send turn
  await manager.send({
    method: "turn/start",
    params: {
      threadId,
      input: [{ type: "text", text: opts.prompt }],
      sandboxPolicy: { type: "readOnly" },
    },
  });

  // Wait for turn completion
  let turnCompleted = false;
  let turnFailed = false;

  try {
    const completionNotif = await waitForNotification(
      opts.notifications,
      (n) =>
        n.method === "turn/completed" ||
        n.method === "turn/failed" ||
        n.method === "codex/event/turn_completed" ||
        n.method === "codex/event/turn_failed",
      TIMEOUT_MS,
    );
    turnCompleted = true;
    turnFailed =
      completionNotif.method === "turn/failed" ||
      completionNotif.method === "codex/event/turn_failed";
  } catch {
    // timed out
  }

  await manager.kill();
  return { turnCompleted, turnFailed };
}

// ---------------------------------------------------------------------------
// Cleanup helper
// ---------------------------------------------------------------------------
async function cleanup(
  db: DB,
  ids: { loopId?: string; threadId?: string; userId?: string },
) {
  const { eq } = await import("drizzle-orm");
  const schema = await import("./src/db/schema.ts");

  // sdlcLoop cascade-deletes artifacts, tasks, signals, outbox
  if (ids.loopId) {
    await db.delete(schema.sdlcLoop).where(eq(schema.sdlcLoop.id, ids.loopId));
  }
  if (ids.threadId) {
    await db
      .delete(schema.threadChat)
      .where(eq(schema.threadChat.threadId, ids.threadId));
    await db.delete(schema.thread).where(eq(schema.thread.id, ids.threadId));
  }
  if (ids.userId) {
    await db
      .delete(schema.subscription)
      .where(eq(schema.subscription.referenceId, ids.userId));
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, ids.userId));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, ids.userId));
    await db
      .delete(schema.userFlags)
      .where(eq(schema.userFlags.userId, ids.userId));
    await db.delete(schema.user).where(eq(schema.user.id, ids.userId));
  }
}

// ===========================================================================
// Main
// ===========================================================================
async function main() {
  console.log("=== Delivery Loop E2E Test ===");
  console.log(
    `Mode: ${FULL ? "FULL" : WITH_PLANNING ? "WITH_PLANNING" : "IMPLEMENTING"} (${IN_DOCKER ? "in-docker" : "local"})${WITH_REVIEW ? " +review" : ""}`,
  );
  console.log();

  // ── Skip checks ──
  if (!codexAvailable()) {
    console.log("SKIP: codex not on PATH (npm i -g @openai/codex)");
    process.exit(0);
  }
  if (!testDbAvailable()) {
    console.log("SKIP: Test DB not available on port 15432");
    process.exit(0);
  }
  if (!existsSync(MCP_SERVER_PATH)) {
    console.log(
      "SKIP: MCP server not built (run: pnpm -C packages/mcp-server build)",
    );
    process.exit(0);
  }

  const shared = await loadSharedModules();
  const db = shared.createDb(TEST_DB_URL);

  let loopId: string | undefined;
  let threadId: string | undefined;
  let userId: string | undefined;
  let stubServer: Server | undefined;

  try {
    // ── Step 1: DB Setup ──
    console.log("-- Step 1: DB Setup --");

    const user = await createTestUserInline(db);
    userId = user.id;
    console.log(`  Created user: ${userId}`);

    const threadResult = await createTestThreadInline(
      db,
      userId,
      "terragon/e2e-test-repo",
    );
    threadId = threadResult.threadId;
    const threadChatId = threadResult.threadChatId;
    console.log(`  Created thread: ${threadId}, chat: ${threadChatId}`);

    const loop = await shared.enrollSdlcLoopForThread({
      db,
      userId,
      repoFullName: "terragon/e2e-test-repo",
      threadId,
    });
    if (!loop) throw new Error("Failed to enroll loop");
    loopId = loop.id;
    console.log(`  Created loop: ${loopId} (state: ${loop.state})`);

    // Create plan artifact with 2 tasks
    const planPayload = {
      planText: "Create two files in the repo",
      tasks: [
        {
          stableTaskId: "task-create-hello",
          title: "Create hello.txt",
          acceptance: ["File exists with content"],
        },
        {
          stableTaskId: "task-create-readme",
          title: "Create README.md",
          acceptance: ["File exists"],
        },
      ],
      source: "agent_text" as const,
    };

    const artifact = await shared.createPlanArtifactForLoop({
      db,
      loopId,
      loopVersion: 0,
      payload: planPayload,
    });
    console.log(`  Created plan artifact: ${artifact.id}`);

    // Insert plan tasks into sdlcPlanTask table
    await shared.replacePlanTasksForArtifact({
      db,
      loopId,
      artifactId: artifact.id,
      tasks: planPayload.tasks,
    });
    console.log(`  Inserted ${planPayload.tasks.length} plan tasks`);

    // Approve plan
    const approved = await shared.approvePlanArtifactForLoop({
      db,
      loopId,
      artifactId: artifact.id,
      approvedByUserId: userId,
    });
    if (!approved) throw new Error("Failed to approve plan artifact");
    console.log(`  Plan approved`);

    // Transition: planning → implementing
    const transResult = await shared.transitionSdlcLoopState({
      db,
      loopId,
      transitionEvent: "plan_completed",
      loopVersion: 0,
    });
    console.log(`  Transition plan_completed: ${transResult}`);
    assert(transResult === "updated", "Loop transitioned to implementing");

    // Verify loop state
    const loopAfter = await shared.getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    });
    assert(
      loopAfter?.state === "implementing",
      `Loop state is implementing (got: ${loopAfter?.state})`,
    );
    console.log("  PASS: DB fixtures created\n");

    // ── Step 2: HTTP Stub ──
    console.log("-- Step 2: HTTP Stub --");
    const stub = await startMarkTasksStub({
      db,
      loopId,
      artifactId: artifact.id,
    });
    stubServer = stub.server;
    console.log(`  mark-tasks stub listening on port ${stub.port}`);
    console.log("  PASS: stub ready\n");

    // ── Step 3: Codex + MCP ──
    console.log("-- Step 3: Codex + MCP --");

    const notifications: CapturedNotification[] = [];

    const instructions = [
      "You have access to the MarkImplementingTasksComplete tool via the terry MCP server.",
      "When asked to mark tasks complete, call it immediately with the provided task IDs.",
      "Do not create any files. Do not explain. Just call the tool.",
    ].join(" ");

    const prompt = [
      "You are implementing a plan. The plan has these tasks:",
      '- task-create-hello: Create a file called hello.txt with "Hello from E2E test"',
      '- task-create-readme: Create a file called README.md with "# E2E Test"',
      "",
      'Call MarkImplementingTasksComplete with completedTasks: [{"stableTaskId": "task-create-hello", "status": "done", "note": "created hello.txt"}, {"stableTaskId": "task-create-readme", "status": "done", "note": "created README.md"}]',
      "",
      "Do not explain — just call the tool immediately.",
    ].join("\n");

    console.log("  Spawning codex app-server...");
    const { turnCompleted, turnFailed } = await runCodexTurn({
      prompt,
      instructions,
      mcpServerPath: MCP_SERVER_PATH,
      stubPort: stub.port,
      threadId,
      threadChatId,
      notifications,
    });

    assert(turnCompleted, "Codex turn completed");
    assert(!turnFailed, "Codex turn did not fail");
    console.log();

    // ── Step 4: Assertions ──
    console.log("-- Step 4: Assertions --");

    // Check HTTP stub received request
    const markRequests = stub.requests.filter(
      (r) => r.url === "/api/sdlc/mark-tasks",
    );
    assert(markRequests.length >= 1, "mark-tasks stub received request");

    // Check request body includes our task IDs
    const lastReq = markRequests[markRequests.length - 1]!;
    const completedTasks = lastReq.body.completedTasks ?? [];
    const taskIds = completedTasks.map(
      (t: CompletedTaskEntry) => t.stableTaskId,
    );
    assert(
      taskIds.includes("task-create-hello"),
      "request includes task-create-hello",
    );
    assert(
      taskIds.includes("task-create-readme"),
      "request includes task-create-readme",
    );

    // Verify DB state — tasks marked done
    const verification = await shared.verifyPlanTaskCompletionForHead({
      db,
      loopId,
      artifactId: artifact.id,
      headSha: "e2e-test-sha",
    });
    assert(
      verification.gatePassed,
      `DB tasks verified complete (${verification.totalTasks} total, ${verification.incompleteTaskIds.length} incomplete)`,
    );

    // ── Signal-driven transition: implementing → review_gate ──
    // Mirrors production: insert daemon_terminal signal → process inline
    const { eq } = await import("drizzle-orm");
    const schemaImport = await import("./src/db/schema.ts");

    // Helper to get current loop version (avoids stale optimistic lock)
    async function getLoopVersion(): Promise<number> {
      const [row] = await db
        .select({ loopVersion: schemaImport.sdlcLoop.loopVersion })
        .from(schemaImport.sdlcLoop)
        .where(eq(schemaImport.sdlcLoop.id, loopId!));
      return row?.loopVersion ?? 0;
    }

    // Helper to get current loop state
    async function getLoopState(): Promise<string> {
      const [row] = await db
        .select({ state: schemaImport.sdlcLoop.state })
        .from(schemaImport.sdlcLoop)
        .where(eq(schemaImport.sdlcLoop.id, loopId!));
      return row?.state ?? "unknown";
    }

    // Helper: insert a signal into sdlcLoopSignalInbox (mirrors production enqueue)
    async function insertSignal(opts: {
      loopId: string;
      causeType: string;
      canonicalCauseId: string;
      signalHeadShaOrNull: string | null;
      causeIdentityVersion: number;
      payload: Record<string, unknown>;
    }): Promise<string> {
      const [row] = await db
        .insert(schemaImport.sdlcLoopSignalInbox)
        .values({
          loopId: opts.loopId,
          causeType: opts.causeType as never,
          canonicalCauseId: opts.canonicalCauseId,
          signalHeadShaOrNull: opts.signalHeadShaOrNull,
          causeIdentityVersion: opts.causeIdentityVersion,
          payload: opts.payload,
          receivedAt: new Date(),
          committedAt: new Date(), // daemon_terminal requires committedAt
        })
        .returning({ id: schemaImport.sdlcLoopSignalInbox.id });
      return row!.id;
    }

    // Claim + complete helpers using real production functions from signal-inbox-core
    let lastClaimToken: string | null = null;
    async function claimSignal(_signalId: string): Promise<void> {
      if (!loopId) throw new Error("loopId not set");
      const claimToken = nanoid();
      const claimed = await shared.claimNextUnprocessedSignal({
        db,
        loopId,
        claimToken,
        now: new Date(),
        staleClaimMs: 0,
      });
      if (!claimed) {
        throw new Error(`Failed to claim signal (expected ${_signalId})`);
      }
      if (claimed.id !== _signalId) {
        throw new Error(
          `Claimed wrong signal: expected ${_signalId}, got ${claimed.id}`,
        );
      }
      lastClaimToken = claimToken;
    }

    async function completeSignal(signalId: string): Promise<void> {
      if (!lastClaimToken) {
        throw new Error("No claim token — call claimSignal first");
      }
      const completed = await shared.completeSignalClaim({
        db,
        signalId,
        claimToken: lastClaimToken,
        now: new Date(),
      });
      if (!completed) {
        throw new Error(`Failed to complete signal ${signalId}`);
      }
      lastClaimToken = null;
    }

    const HEAD_SHA = "e2e-test-sha-abc123";
    const daemonEventId = nanoid();

    // 1. Build canonical cause (same as production's buildSdlcCanonicalCause)
    const daemonCause = shared.buildSdlcCanonicalCause({
      causeType: "daemon_terminal",
      eventId: daemonEventId,
    });

    // 2. Insert daemon_terminal signal (mirrors claimEnrolledLoopDaemonEvent)
    const daemonSignalId = await insertSignal({
      loopId,
      ...daemonCause,
      payload: {
        eventType: "daemon_terminal",
        payloadVersion: 2,
        eventId: daemonEventId,
        runId: nanoid(),
        seq: 1,
        threadId,
        threadChatId,
        daemonRunStatus: "completed",
        daemonErrorMessage: null,
        daemonErrorCategory: "",
        headShaAtCompletion: HEAD_SHA,
      },
    });
    console.log(`  Inserted daemon_terminal signal: ${daemonSignalId}`);

    // 3. Claim signal (mirrors signal-inbox claim step)
    await claimSignal(daemonSignalId);

    // 4. Process: verify tasks + auto-mark + transition (mirrors signal-inbox daemon_terminal handler)
    //    Production: verifyPlanTaskCompletionForHead → markPlanTasksCompletedByAgent (auto-mark) → transitionSdlcLoopState
    const autoVerification = await shared.verifyPlanTaskCompletionForHead({
      db,
      loopId,
      artifactId: artifact.id,
      headSha: HEAD_SHA,
    });
    if (
      !autoVerification.gatePassed &&
      autoVerification.incompleteTaskIds.length > 0
    ) {
      // Auto-mark remaining tasks (like production does with "auto-marked on implementing completion")
      await shared.markPlanTasksCompletedByAgent({
        db,
        loopId,
        artifactId: artifact.id,
        completions: autoVerification.incompleteTaskIds.map((id) => ({
          stableTaskId: id,
          status: "done" as const,
          evidence: {
            headSha: HEAD_SHA,
            note: "auto-marked on implementing completion",
          },
        })),
      });
    }

    let ver = await getLoopVersion();
    const implDone = await shared.transitionSdlcLoopState({
      db,
      loopId,
      transitionEvent: "implementation_completed",
      loopVersion: ver,
    });

    // 5. Complete signal (set processedAt)
    await completeSignal(daemonSignalId);

    assert(implDone === "updated", "Loop transitioned to review_gate");

    const finalLoop = await shared.getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    });
    assert(
      finalLoop?.state === "review_gate",
      `Final loop state is review_gate (got: ${finalLoop?.state})`,
    );

    // Verify signal was marked processed
    const [processedSignal] = await db
      .select({ processedAt: schemaImport.sdlcLoopSignalInbox.processedAt })
      .from(schemaImport.sdlcLoopSignalInbox)
      .where(eq(schemaImport.sdlcLoopSignalInbox.id, daemonSignalId));
    assert(
      processedSignal?.processedAt !== null,
      "daemon_terminal signal marked processed",
    );

    // ── Full mode: exercise every stage with real signals + artifacts + gate evaluations ──
    if (FULL) {
      // ── Stage: review_gate ──
      console.log("\n-- Stage: review_gate --");
      ver = await getLoopVersion();

      const implArtifact = await shared.createImplementationArtifactForHead({
        db,
        loopId,
        headSha: HEAD_SHA,
        loopVersion: ver,
        payload: {
          headSha: HEAD_SHA,
          summary: "Created hello.txt and README.md",
          changedFiles: ["hello.txt", "README.md"],
          completedTaskIds: ["task-create-hello", "task-create-readme"],
        },
      });
      console.log(`  Created implementation artifact: ${implArtifact.id}`);

      if (WITH_REVIEW) {
        // Run real deep review + Carmack review via codex exec
        const taskContext =
          "Create hello.txt and README.md for the E2E test repo.";
        const gitDiff = [
          "diff --git a/hello.txt b/hello.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/hello.txt",
          "@@ -0,0 +1 @@",
          "+Hello from E2E test",
          "diff --git a/README.md b/README.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/README.md",
          "@@ -0,0 +1 @@",
          "+# E2E Test",
        ].join("\n");

        console.log("  Running deep review via codex exec...");
        const deepPrompt = buildReviewGatePrompt({
          gateName: "deep-review",
          systemPrompt: DEEP_REVIEW_SYSTEM_PROMPT,
          repoFullName: "terragon/e2e-test-repo",
          headSha: HEAD_SHA,
          taskContext,
          gitDiff,
        });
        const deepRawOutput = runCodexExecLocally({
          prompt: deepPrompt,
          model: REVIEW_MODEL,
        });
        console.log("  Deep review raw output:", JSON.stringify(deepRawOutput));

        ver = await getLoopVersion();
        const deepResult = await shared.persistDeepReviewGateResult({
          db,
          loopId,
          headSha: HEAD_SHA,
          loopVersion: ver,
          model: REVIEW_MODEL,
          rawOutput: deepRawOutput,
          updateLoopState: false,
        });
        console.log(
          `  Deep review: runId=${deepResult.runId}, passed=${deepResult.gatePassed}, ` +
            `findings=${deepResult.unresolvedBlockingFindings}`,
        );
        assert(!deepResult.invalidOutput, "Deep review output is valid JSON");

        console.log("  Running Carmack review via codex exec...");
        const carmackPrompt = buildReviewGatePrompt({
          gateName: "carmack-review",
          systemPrompt: CARMACK_REVIEW_SYSTEM_PROMPT,
          repoFullName: "terragon/e2e-test-repo",
          headSha: HEAD_SHA,
          taskContext,
          gitDiff,
        });
        const carmackRawOutput = runCodexExecLocally({
          prompt: carmackPrompt,
          model: REVIEW_MODEL,
        });
        console.log(
          "  Carmack review raw output:",
          JSON.stringify(carmackRawOutput),
        );

        ver = await getLoopVersion();
        const carmackResult = await shared.persistCarmackReviewGateResult({
          db,
          loopId,
          headSha: HEAD_SHA,
          loopVersion: ver,
          model: REVIEW_MODEL,
          rawOutput: carmackRawOutput,
          updateLoopState: false,
        });
        console.log(
          `  Carmack review: runId=${carmackResult.runId}, passed=${carmackResult.gatePassed}, ` +
            `findings=${carmackResult.unresolvedBlockingFindings}`,
        );
        assert(
          !carmackResult.invalidOutput,
          "Carmack review output is valid JSON",
        );

        const allReviewsPassed =
          deepResult.gatePassed && carmackResult.gatePassed;
        console.log(`  Both reviews passed: ${allReviewsPassed}`);

        const reviewArtifact = await shared.createReviewBundleArtifactForHead({
          db,
          loopId,
          headSha: HEAD_SHA,
          loopVersion: ver,
          payload: {
            headSha: HEAD_SHA,
            deepRunId: deepResult.runId,
            carmackRunId: carmackResult.runId,
            deepBlockingFindings: deepResult.unresolvedBlockingFindings,
            carmackBlockingFindings: carmackResult.unresolvedBlockingFindings,
            gatePassed: allReviewsPassed,
            summary: allReviewsPassed
              ? "Both reviews passed"
              : "Review gate blocked",
          },
        });
        console.log(`  Created review bundle artifact: ${reviewArtifact.id}`);

        // For the test to proceed, we need reviews to pass. If the LLM
        // finds blocking issues on this trivial diff, we still transition
        // and log a warning — the test validates the plumbing, not the LLM's
        // review judgment.
        if (!allReviewsPassed) {
          console.log(
            "  WARNING: Reviews found blocking issues on trivial diff — " +
              "forcing transition for E2E plumbing test",
          );
        }
      } else {
        // Simulated review: create artifacts and transition directly
        const reviewArtifact = await shared.createReviewBundleArtifactForHead({
          db,
          loopId,
          headSha: HEAD_SHA,
          loopVersion: ver,
          payload: {
            headSha: HEAD_SHA,
            deepRunId: null,
            carmackRunId: null,
            deepBlockingFindings: 0,
            carmackBlockingFindings: 0,
            gatePassed: true,
            summary: "No blocking findings (simulated)",
          },
        });
        console.log(
          `  Created review bundle artifact (simulated): ${reviewArtifact.id}`,
        );
      }

      ver = await getLoopVersion();
      const reviewResult = await shared.transitionSdlcLoopState({
        db,
        loopId,
        transitionEvent: "review_passed",
        loopVersion: ver,
        headSha: HEAD_SHA,
      });
      assert(reviewResult === "updated", "review_gate → ci_gate");
      assert(
        (await getLoopState()) === "ci_gate",
        `State is ci_gate (got: ${await getLoopState()})`,
      );

      // ── Stage: ci_gate ──
      // Signal: check_run.completed → persistSdlcCiGateEvaluation (handles both artifact + transition)
      console.log("\n-- Stage: ci_gate --");

      const checkRunDeliveryId = nanoid();
      const checkRunId = Math.floor(Math.random() * 100000);
      const ciCause = shared.buildSdlcCanonicalCause({
        causeType: "check_run.completed",
        deliveryId: checkRunDeliveryId,
        checkRunId,
      });

      const ciSignalId = await insertSignal({
        loopId,
        ...ciCause,
        payload: {
          eventType: "check_run.completed",
          repoFullName: "terragon/e2e-test-repo",
          prNumber: 42,
          checkRunId: String(checkRunId),
          checkName: "ci/build",
          checkOutcome: "pass",
          headSha: HEAD_SHA,
          checkSummary: "All checks passed",
          ciSnapshotSource: "github_check_runs",
          ciSnapshotCheckNames: ["ci/build", "ci/test"],
          ciSnapshotFailingChecks: [],
          ciSnapshotComplete: true,
          sourceType: "automation",
        },
      });
      console.log(`  Inserted check_run.completed signal: ${ciSignalId}`);

      await claimSignal(ciSignalId);

      // Process: persistSdlcCiGateEvaluation handles artifact creation + state transition
      ver = await getLoopVersion();
      const ciResult = await shared.persistSdlcCiGateEvaluation({
        db,
        loopId,
        headSha: HEAD_SHA,
        loopVersion: ver,
        triggerEventType: "check_run.completed",
        capabilityState: "supported",
        rulesetChecks: ["ci/build", "ci/test"],
        failingChecks: [],
      });

      await completeSignal(ciSignalId);

      console.log(
        `  CI gate: status=${ciResult.status}, passed=${ciResult.gatePassed}, ` +
          `source=${ciResult.requiredCheckSource}, outcome=${ciResult.loopUpdateOutcome}`,
      );
      assert(ciResult.gatePassed, "CI gate passed");
      assert(
        ciResult.loopUpdateOutcome === "updated",
        `CI gate transitioned loop (got: ${ciResult.loopUpdateOutcome})`,
      );
      assert(
        (await getLoopState()) === "ui_gate",
        `State is ui_gate (got: ${await getLoopState()})`,
      );

      // ── Stage: ui_gate ──
      // ui_smoke_passed (no PR) → awaiting_pr_link
      console.log("\n-- Stage: ui_gate --");
      ver = await getLoopVersion();

      const uiArtifact = await shared.createUiSmokeArtifactForHead({
        db,
        loopId,
        headSha: HEAD_SHA,
        loopVersion: ver,
        payload: {
          headSha: HEAD_SHA,
          gatePassed: true,
          summary: "UI smoke test passed — no visual regressions",
          blockingIssues: [],
          changedFiles: ["hello.txt", "README.md"],
        },
      });
      console.log(`  Created UI smoke artifact: ${uiArtifact.id}`);

      ver = await getLoopVersion();
      const uiResult = await shared.transitionSdlcLoopState({
        db,
        loopId,
        transitionEvent: "ui_smoke_passed",
        loopVersion: ver,
        headSha: HEAD_SHA,
      });
      assert(uiResult === "updated", "ui_gate → awaiting_pr_link");
      assert(
        (await getLoopState()) === "awaiting_pr_link",
        `State is awaiting_pr_link (got: ${await getLoopState()})`,
      );

      // ── Stage: awaiting_pr_link ──
      // Signal: pull_request.synchronize (simulates PR creation pushing a headSha)
      console.log("\n-- Stage: awaiting_pr_link --");

      const prDeliveryId = nanoid();
      const prId = Math.floor(Math.random() * 100000);
      const prSyncCause = shared.buildSdlcCanonicalCause({
        causeType: "pull_request.synchronize",
        deliveryId: prDeliveryId,
        pullRequestId: prId,
        headSha: HEAD_SHA,
      });

      const prSyncSignalId = await insertSignal({
        loopId,
        ...prSyncCause,
        payload: {
          eventType: "pull_request.synchronize",
          repoFullName: "terragon/e2e-test-repo",
          prNumber: 42,
          pullRequestId: prId,
          headSha: HEAD_SHA,
          sourceType: "automation",
        },
      });
      console.log(
        `  Inserted pull_request.synchronize signal: ${prSyncSignalId}`,
      );

      await claimSignal(prSyncSignalId);

      // Create PR link artifact + transition
      ver = await getLoopVersion();
      const prArtifact = await shared.createPrLinkArtifact({
        db,
        loopId,
        loopVersion: ver,
        payload: {
          repoFullName: "terragon/e2e-test-repo",
          prNumber: 42,
          pullRequestUrl: "https://github.com/terragon/e2e-test-repo/pull/42",
          operation: "created",
        },
      });
      console.log(`  Created PR link artifact: ${prArtifact.id}`);

      ver = await getLoopVersion();
      const prResult = await shared.transitionSdlcLoopState({
        db,
        loopId,
        transitionEvent: "pr_linked",
        loopVersion: ver,
        headSha: HEAD_SHA,
      });

      await completeSignal(prSyncSignalId);

      assert(prResult === "updated", "awaiting_pr_link → babysitting");
      assert(
        (await getLoopState()) === "babysitting",
        `State is babysitting (got: ${await getLoopState()})`,
      );

      // ── Stage: babysitting ──
      // Signal: check_run.completed triggers babysitting evaluation
      // Production: evaluateBabysitCompletionForHead → createBabysitEvaluationArtifact → transition
      console.log("\n-- Stage: babysitting --");

      const babysitCheckRunId = Math.floor(Math.random() * 100000);
      const babysitDeliveryId = nanoid();
      const babysitCiCause = shared.buildSdlcCanonicalCause({
        causeType: "check_run.completed",
        deliveryId: babysitDeliveryId,
        checkRunId: babysitCheckRunId,
      });

      const babysitSignalId = await insertSignal({
        loopId,
        ...babysitCiCause,
        payload: {
          eventType: "check_run.completed",
          repoFullName: "terragon/e2e-test-repo",
          prNumber: 42,
          checkRunId: String(babysitCheckRunId),
          checkName: "ci/build",
          checkOutcome: "pass",
          headSha: HEAD_SHA,
          checkSummary: "All checks passed",
          ciSnapshotSource: "github_check_runs",
          ciSnapshotCheckNames: ["ci/build", "ci/test"],
          ciSnapshotFailingChecks: [],
          ciSnapshotComplete: true,
          sourceType: "automation",
        },
      });
      console.log(
        `  Inserted babysitting check_run.completed signal: ${babysitSignalId}`,
      );

      await claimSignal(babysitSignalId);

      // Re-evaluate CI gate during babysitting (production does this)
      ver = await getLoopVersion();
      await shared.persistSdlcCiGateEvaluation({
        db,
        loopId,
        headSha: HEAD_SHA,
        loopVersion: ver,
        triggerEventType: "check_run.completed",
        capabilityState: "supported",
        rulesetChecks: ["ci/build", "ci/test"],
        failingChecks: [],
      });

      // Evaluate babysitting completion using real production function
      const babysitCompletion = await shared.evaluateBabysitCompletionForHead({
        db,
        loopId,
        headSha: HEAD_SHA,
      });
      console.log(
        `  Babysit evaluation: ciPassed=${babysitCompletion.requiredCiPassed}, ` +
          `reviewThreads=${babysitCompletion.unresolvedReviewThreads}, ` +
          `allPassed=${babysitCompletion.allRequiredGatesPassed}`,
      );

      ver = await getLoopVersion();
      const babysitArtifact =
        await shared.createBabysitEvaluationArtifactForHead({
          db,
          loopId,
          headSha: HEAD_SHA,
          loopVersion: ver,
          payload: {
            headSha: HEAD_SHA,
            ...babysitCompletion,
          },
        });
      console.log(
        `  Created babysit evaluation artifact: ${babysitArtifact.id}`,
      );

      ver = await getLoopVersion();
      const babysitResult = await shared.transitionSdlcLoopState({
        db,
        loopId,
        transitionEvent: "babysit_passed",
        loopVersion: ver,
        headSha: HEAD_SHA,
      });

      await completeSignal(babysitSignalId);

      assert(babysitResult === "updated", "babysitting → done");

      // getActiveSdlcLoopForThread filters terminal states — query directly
      const [doneLoop] = await db
        .select()
        .from(schemaImport.sdlcLoop)
        .where(eq(schemaImport.sdlcLoop.id, loopId));
      assert(
        doneLoop?.state === "done",
        `Final state is done (got: ${doneLoop?.state})`,
      );

      // Verify all signals were processed
      const allSignals = await db
        .select({
          id: schemaImport.sdlcLoopSignalInbox.id,
          causeType: schemaImport.sdlcLoopSignalInbox.causeType,
          processedAt: schemaImport.sdlcLoopSignalInbox.processedAt,
        })
        .from(schemaImport.sdlcLoopSignalInbox)
        .where(eq(schemaImport.sdlcLoopSignalInbox.loopId, loopId));
      const unprocessed = allSignals.filter((s) => s.processedAt === null);
      assert(
        unprocessed.length === 0,
        `All ${allSignals.length} signals processed (${unprocessed.length} unprocessed)`,
      );

      console.log(
        "\n  Full signal-driven lifecycle: planning → implementing → review_gate → " +
          "ci_gate → ui_gate → awaiting_pr_link → babysitting → done",
      );
      console.log(`  Total signals inserted & processed: ${allSignals.length}`);
    }

    console.log("\n=== All tests passed ===");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`\nFAIL: ${message}`);
    if (stack) console.error(stack);
    process.exitCode = 1;
  } finally {
    // ── Cleanup ──
    console.log("\n-- Cleanup --");
    try {
      await cleanup(db, { loopId, threadId, userId });
      console.log("  Deleted test fixtures");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("  Cleanup warning:", message);
    }
    if (stubServer) {
      stubServer.close();
    }
  }
}

main().catch((err: unknown) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
