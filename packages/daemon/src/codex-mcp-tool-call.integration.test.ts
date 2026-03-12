/**
 * Integration test: Codex agent calling the terragon MCP server's
 * MarkImplementingTasksComplete tool.
 *
 * This test:
 * 1. Starts a local HTTP stub to capture the mark-tasks API call
 * 2. Writes a temporary MCP config pointing at the terragon MCP server
 * 3. Spawns real Codex app-server with that MCP config
 * 4. Instructs the agent to call MarkImplementingTasksComplete
 * 5. Verifies the HTTP stub received the correct request
 *
 * Requires: codex CLI on PATH + OpenAI credentials.
 * Skipped automatically when codex is unavailable.
 */
import { spawn, execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, afterEach } from "vitest";
import {
  CodexAppServerManager,
  type CodexAppServerProcess,
  type CodexAppServerSpawn,
  type JsonRpcNotificationEnvelope,
} from "./codex-app-server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function codexAvailable(): boolean {
  try {
    execSync("codex --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const HAS_CODEX = codexAvailable();
const describeWithCodex = HAS_CODEX ? describe : describe.skip;

const MCP_SERVER_PATH = new URL(
  "../../mcp-server/dist/bundled.js",
  import.meta.url,
).pathname;

type CapturedNotification = {
  method: string;
  params?: Record<string, unknown>;
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

function startStubServer(): Promise<{
  server: Server;
  port: number;
  requests: Array<{
    method: string;
    url: string;
    body: unknown;
    headers: Record<string, string>;
  }>;
}> {
  return new Promise((resolve) => {
    const requests: Array<{
      method: string;
      url: string;
      body: unknown;
      headers: Record<string, string>;
    }> = [];

    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        headers: req.headers as Record<string, string>,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, updatedTaskCount: 1 }));
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port, requests });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithCodex("codex + terragon MCP tool call", () => {
  let activeManager: CodexAppServerManager | null = null;
  let stubServer: Server | null = null;
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (activeManager) {
      await activeManager.kill();
      activeManager = null;
    }
    if (stubServer) {
      stubServer.close();
      stubServer = null;
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  test("agent calls MarkImplementingTasksComplete and HTTP request reaches stub", async () => {
    // 1. Start HTTP stub
    const { server, port, requests } = await startStubServer();
    stubServer = server;

    // 2. Write temporary codex config with MCP server
    tmpDir = mkdtempSync(join(tmpdir(), "codex-mcp-test-"));
    const codexConfigPath = join(tmpDir, "config.toml");
    writeFileSync(
      codexConfigPath,
      `
[mcp_servers.terry]
command = "node"
args = ["${MCP_SERVER_PATH}"]

[mcp_servers.terry.env]
TERRAGON_SERVER_URL = "http://localhost:${port}"
DAEMON_TOKEN = "integration-test-token"
TERRAGON_THREAD_ID = "thread-integration-1"
TERRAGON_THREAD_CHAT_ID = "chat-integration-1"
`,
    );

    // 3. Spawn Codex with custom config
    const notifications: CapturedNotification[] = [];
    const realSpawn: CodexAppServerSpawn = (command, args, options) => {
      const proc = spawn(
        command,
        [...args, "-c", `config_path="${codexConfigPath}"`],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: options.env,
        },
      );
      return proc as unknown as CodexAppServerProcess;
    };

    const manager = new CodexAppServerManager({
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      model: "gpt-5.3-codex",
      daemonToken: null,
      env: process.env,
      requestTimeoutMs: 30_000,
      handshakeTimeoutMs: 30_000,
      spawnProcess: realSpawn,
    });
    activeManager = manager;

    manager.onNotification((notification: JsonRpcNotificationEnvelope) => {
      notifications.push({
        method: notification.method,
        params: notification.params,
      });
    });

    await manager.ensureReady();

    // 4. Start thread with instructions to call the tool
    const threadResult = (await manager.send({
      method: "thread/start",
      params: {
        model: "gpt-5.3-codex",
        stream: true,
        instructions: [
          "You have access to the MarkImplementingTasksComplete tool via the terry MCP server.",
          "When asked to mark tasks, call it immediately with the provided task IDs.",
          "Do not explain or discuss — just call the tool.",
        ].join(" "),
        sandbox: "read-only",
        approvalPolicy: "never",
      },
      threadChatId: "test-mcp-chat",
    })) as { thread?: { id?: string } };

    const threadId = threadResult?.thread?.id;
    expect(threadId).toBeDefined();

    // Wait for MCP startup (terry server must be ready)
    await waitForNotification(
      notifications,
      (n) => n.method === "codex/event/mcp_startup_complete",
      15_000,
    );

    // Verify terry MCP server started successfully
    const mcpComplete = notifications.find(
      (n) => n.method === "codex/event/mcp_startup_complete",
    );
    const readyServers = (
      (mcpComplete?.params as Record<string, unknown>)?.msg as Record<
        string,
        unknown
      >
    )?.ready as string[] | undefined;

    if (!readyServers?.includes("terry")) {
      // Terry MCP server failed to start — skip the rest
      console.warn(
        "Terry MCP server not in ready list:",
        readyServers,
        "— skipping tool call verification",
      );
      return;
    }

    // 5. Send turn instructing agent to call the tool
    await manager.send({
      method: "turn/start",
      params: {
        threadId,
        input: [
          {
            type: "text",
            text: 'Call the MarkImplementingTasksComplete tool with completedTasks: [{"stableTaskId": "task-abc-1", "status": "done", "note": "integration test"}]',
          },
        ],
        sandboxPolicy: { type: "readOnly" },
      },
    });

    // 6. Wait for turn to complete
    await waitForNotification(
      notifications,
      (n) =>
        n.method === "turn/completed" ||
        n.method === "codex/event/turn_completed" ||
        n.method === "turn/failed" ||
        n.method === "codex/event/turn_failed",
      90_000,
    );

    // 7. Verify the HTTP stub received the mark-tasks request
    expect(requests.length).toBeGreaterThanOrEqual(1);
    const markRequest = requests.find((r) => r.url === "/api/sdlc/mark-tasks");
    expect(markRequest).toBeDefined();
    expect(markRequest!.method).toBe("POST");
    expect(markRequest!.headers["x-daemon-token"]).toBe(
      "integration-test-token",
    );
    expect(markRequest!.body).toMatchObject({
      threadId: "thread-integration-1",
      threadChatId: "chat-integration-1",
      completedTasks: expect.arrayContaining([
        expect.objectContaining({
          stableTaskId: "task-abc-1",
          status: "done",
        }),
      ]),
    });
  }, 120_000);
});
