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
 *
 * Requires:
 *   - codex CLI on PATH (npm i -g @openai/codex)
 *   - Test DB running on port 15432 (docker compose up)
 *   - MCP server built (pnpm -C packages/mcp-server build)
 *   - OpenAI credentials (~/.codex/auth.json or OPENAI_API_KEY)
 */

import { spawn, execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
const MODEL = process.env.CODEX_MODEL ?? "gpt-5.3-codex";
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
  } = await import("./src/model/delivery-loop.ts");

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
  };
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
    `Mode: ${FULL ? "FULL" : WITH_PLANNING ? "WITH_PLANNING" : "IMPLEMENTING"} (${IN_DOCKER ? "in-docker" : "local"})`,
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

    // Transition: implementing → review_gate (simulates signal-inbox)
    const implDone = await shared.transitionSdlcLoopState({
      db,
      loopId,
      transitionEvent: "implementation_completed",
      loopVersion: 1,
    });
    assert(implDone === "updated", "Loop transitioned to review_gate");

    // Verify final loop state
    const finalLoop = await shared.getActiveSdlcLoopForThread({
      db,
      userId,
      threadId,
    });
    assert(
      finalLoop?.state === "review_gate",
      `Final loop state is review_gate (got: ${finalLoop?.state})`,
    );

    // ── Full mode: simulate remaining phases ──
    if (FULL) {
      console.log("\n-- Step 5: Full Lifecycle (simulated) --");

      // review_gate → ci_gate
      const reviewResult = await shared.transitionSdlcLoopState({
        db,
        loopId,
        transitionEvent: "review_passed",
        loopVersion: 2,
      });
      assert(reviewResult === "updated", "Transition: review_gate → ci_gate");

      // ci_gate → babysitting (or done)
      const ciResult = await shared.transitionSdlcLoopState({
        db,
        loopId,
        transitionEvent: "ci_gate_passed",
        loopVersion: 3,
      });
      assert(ciResult === "updated", "Transition: ci_gate → next phase");

      const fullFinalLoop = await shared.getActiveSdlcLoopForThread({
        db,
        userId,
        threadId,
      });
      console.log(`  Final state: ${fullFinalLoop?.state}`);
      assert(
        fullFinalLoop != null,
        `Loop progressed through full lifecycle (state: ${fullFinalLoop?.state})`,
      );
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
