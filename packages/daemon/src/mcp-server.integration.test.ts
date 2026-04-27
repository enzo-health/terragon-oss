/**
 * Integration tests for the terragon MCP server.
 *
 * Spawns the real MCP server binary and communicates via JSON-RPC over stdio.
 * Tests tool listing, SuggestFollowupTask, and PermissionPrompt behavior.
 */
import { type ChildProcess, spawn } from "node:child_process";
import readline from "node:readline";
import { afterEach, describe, expect, test } from "vitest";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("terragon MCP server", () => {
  let client: McpTestClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
  });

  test("lists product tools without delivery-loop task marking", async () => {
    client = new McpTestClient();
    await client.initialize();

    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    expect(names).toEqual(["PermissionPrompt", "SuggestFollowupTask"]);
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
});
