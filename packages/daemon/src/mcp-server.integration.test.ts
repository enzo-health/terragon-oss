/**
 * Integration tests for the terragon MCP server.
 *
 * Spawns the real MCP server binary and communicates via JSON-RPC over stdio.
 * Tests tool listing, SuggestFollowupTask, PermissionPrompt, and
 * MarkImplementingTasksComplete behavior.
 *
 * No external API calls — MarkImplementingTasksComplete is tested both with
 * missing env vars (returns isError) and with a local HTTP stub that captures
 * the outgoing request.
 */
import { spawn, type ChildProcess, execSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import readline from "node:readline";
import { describe, test, expect, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MCP_SERVER_PATH = new URL(
  "../../mcp-server/dist/bundled.js",
  import.meta.url,
).pathname;

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

class McpTestClient {
  private proc: ChildProcess;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();

  constructor(env: NodeJS.ProcessEnv = {}) {
    this.proc = spawn("node", [MCP_SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => {
      try {
        const parsed = JSON.parse(line) as JsonRpcResponse;
        if (typeof parsed.id === "number") {
          const p = this.pending.get(parsed.id);
          if (p) {
            this.pending.delete(parsed.id);
            p.resolve(parsed);
          }
        }
      } catch {
        // non-JSON stderr passthrough
      }
    });
  }

  async send(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.proc.stdin!.write(msg + "\n");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.proc.stdin!.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  async initialize(): Promise<void> {
    await this.send("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "test", version: "1.0" },
      capabilities: {},
    });
    this.notify("notifications/initialized");
  }

  async listTools(): Promise<
    Array<{ name: string; description: string; inputSchema: unknown }>
  > {
    const response = await this.send("tools/list");
    const result = response.result as {
      tools: Array<{ name: string; description: string; inputSchema: unknown }>;
    };
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  }> {
    const response = await this.send("tools/call", { name, arguments: args });
    return response.result as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
  }

  async close(): Promise<void> {
    this.proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      this.proc.on("exit", () => resolve());
      setTimeout(() => {
        this.proc.kill("SIGKILL");
        resolve();
      }, 3_000);
    });
  }
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
      res.end(JSON.stringify({ success: true, updatedTaskCount: 2 }));
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

describe("terragon MCP server", () => {
  let client: McpTestClient | null = null;
  let stubServer: Server | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (stubServer) {
      stubServer.close();
      stubServer = null;
    }
  });

  test("lists all three tools with correct schemas", async () => {
    client = new McpTestClient();
    await client.initialize();

    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "MarkImplementingTasksComplete",
      "PermissionPrompt",
      "SuggestFollowupTask",
    ]);

    const markTool = tools.find(
      (t) => t.name === "MarkImplementingTasksComplete",
    )!;
    expect(markTool.inputSchema).toMatchObject({
      type: "object",
      required: ["completedTasks"],
    });
  });

  test("SuggestFollowupTask returns success message", async () => {
    client = new McpTestClient();
    await client.initialize();

    const result = await client.callTool("SuggestFollowupTask", {
      title: "Fix flaky tests",
      description: "Investigate and fix the flaky CI tests in signal-inbox",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Task suggestion presented");
  });

  test("PermissionPrompt denies ExitPlanMode", async () => {
    client = new McpTestClient();
    await client.initialize();

    const result = await client.callTool("PermissionPrompt", {
      tool_name: "ExitPlanMode",
    });

    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.behavior).toBe("deny");
    expect(parsed.message).toContain("reviewing the plan");
  });

  test("PermissionPrompt denies unknown tools", async () => {
    client = new McpTestClient();
    await client.initialize();

    const result = await client.callTool("PermissionPrompt", {
      tool_name: "SomeOtherTool",
    });

    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.behavior).toBe("deny");
    expect(parsed.message).toContain("Unexpected tool");
  });

  test("MarkImplementingTasksComplete returns isError when env vars are missing", async () => {
    // Spawn without TERRAGON_SERVER_URL etc.
    client = new McpTestClient({
      TERRAGON_SERVER_URL: "",
      DAEMON_TOKEN: "",
      TERRAGON_THREAD_ID: "",
      TERRAGON_THREAD_CHAT_ID: "",
    });
    await client.initialize();

    const result = await client.callTool("MarkImplementingTasksComplete", {
      completedTasks: [{ stableTaskId: "task-1" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Missing environment context");
  });

  test("MarkImplementingTasksComplete calls API and returns success", async () => {
    const { server, port, requests } = await startStubServer();
    stubServer = server;

    client = new McpTestClient({
      TERRAGON_SERVER_URL: `http://localhost:${port}`,
      DAEMON_TOKEN: "test-daemon-token",
      TERRAGON_THREAD_ID: "thread-123",
      TERRAGON_THREAD_CHAT_ID: "chat-456",
    });
    await client.initialize();

    const result = await client.callTool("MarkImplementingTasksComplete", {
      completedTasks: [
        { stableTaskId: "task-1", status: "done", note: "implemented" },
        { stableTaskId: "task-2" },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("Marked 2 task(s) as complete");

    // Verify the outgoing HTTP request
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/sdlc/mark-tasks");
    expect(req.headers["x-daemon-token"]).toBe("test-daemon-token");
    expect(req.body).toMatchObject({
      threadId: "thread-123",
      threadChatId: "chat-456",
      completedTasks: [
        { stableTaskId: "task-1", status: "done", note: "implemented" },
        { stableTaskId: "task-2", status: "done", note: null },
      ],
    });
  });

  test("MarkImplementingTasksComplete returns isError on HTTP failure", async () => {
    // Start a stub server that returns 500
    const errorServer = createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    });
    await new Promise<void>((resolve) =>
      errorServer.listen(0, () => resolve()),
    );
    const addr = errorServer.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    stubServer = errorServer;

    client = new McpTestClient({
      TERRAGON_SERVER_URL: `http://localhost:${port}`,
      DAEMON_TOKEN: "test-token",
      TERRAGON_THREAD_ID: "thread-1",
      TERRAGON_THREAD_CHAT_ID: "chat-1",
    });
    await client.initialize();

    const result = await client.callTool("MarkImplementingTasksComplete", {
      completedTasks: [{ stableTaskId: "task-1" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Failed to mark tasks (500)");
  });

  test("MarkImplementingTasksComplete returns isError on network failure", async () => {
    client = new McpTestClient({
      TERRAGON_SERVER_URL: "http://localhost:1", // nothing listening
      DAEMON_TOKEN: "test-token",
      TERRAGON_THREAD_ID: "thread-1",
      TERRAGON_THREAD_CHAT_ID: "chat-1",
    });
    await client.initialize();

    const result = await client.callTool("MarkImplementingTasksComplete", {
      completedTasks: [{ stableTaskId: "task-1" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Failed to reach server");
  });
});
