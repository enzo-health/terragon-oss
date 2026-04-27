import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { DockerProvider } from "./providers/docker-provider";
import { sendMessage } from "./daemon";
import type { ISandboxSession, CreateSandboxOptions } from "./types";
import { getOrCreateSandbox } from "./sandbox";
import { createServer, type IncomingMessage, type Server } from "http";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import net from "net";
import type { DaemonEventAPIBody } from "@terragon/daemon/shared";

const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Populated in beforeAll; null when ~/.codex/auth.json is absent
let codexAuthContents: string | null = null;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : null;
      srv.close(() => {
        if (port) {
          resolve(port);
        } else {
          reject(new Error("Could not get free port"));
        }
      });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function startEventServer(port: number): {
  server: Server;
  events: DaemonEventAPIBody[];
} {
  const events: DaemonEventAPIBody[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/api/daemon-event")) {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body) as DaemonEventAPIBody;
        events.push(parsed);
        res.writeHead(200, { "Content-Type": "application/json" });
        // Daemon payloadVersion 2 requires an envelope ack matching eventId + seq
        const ack: Record<string, unknown> = { ok: true };
        if ("eventId" in parsed && "seq" in parsed) {
          ack.acknowledgedEventId = (parsed as any).eventId;
          ack.acknowledgedSeq = (parsed as any).seq;
        }
        res.end(JSON.stringify(ack));
      } catch {
        res.writeHead(400);
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, "0.0.0.0");
  return { server, events };
}

function getCreateSandboxOptions(
  overrides: Partial<CreateSandboxOptions> = {},
): CreateSandboxOptions {
  return {
    threadName: "daemon-lifecycle-test",
    userName: "test-user",
    userEmail: "test@example.com",
    githubAccessToken: process.env.GITHUB_ACCESS_TOKEN ?? "test-token",
    githubRepoFullName: "SawyerHood/test-project",
    repoBaseBranchName: "main",
    userId: "user-daemon-lifecycle-test",
    sandboxProvider: "docker",
    createNewBranch: true,
    autoUpdateDaemon: false,
    sandboxSize: "small",
    publicUrl: "http://localhost:3000", // overridden below
    featureFlags: {},
    agent: "codex",
    agentCredentials: {
      type: "json-file",
      contents: codexAuthContents!,
    },
    environmentVariables: [],
    generateBranchName: async () => null,
    onStatusUpdate: async () => {},
    ...overrides,
  };
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 120_000, intervalMs = 1_000 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe("daemon lifecycle (codex + local auth)", () => {
  vi.setConfig({ testTimeout: TIMEOUT_MS });

  let sandbox: ISandboxSession;
  let server: Server;
  let events: DaemonEventAPIBody[];
  let port: number;

  beforeAll(async () => {
    const authPath = join(homedir(), ".codex", "auth.json");
    if (existsSync(authPath)) {
      try {
        codexAuthContents = readFileSync(authPath, "utf-8");
      } catch {
        codexAuthContents = null;
      }
    }
    if (!codexAuthContents) return;

    port = await getFreePort();
    ({ server, events } = startEventServer(port));

    // host.docker.internal lets the Docker container reach the host machine
    const publicUrl = `http://host.docker.internal:${port}`;

    sandbox = await getOrCreateSandbox(
      null,
      getCreateSandboxOptions({ publicUrl }),
    );
  }, TIMEOUT_MS);

  afterAll(async () => {
    server?.close();
    try {
      await sandbox?.shutdown();
    } catch {}
    await DockerProvider.cleanupTestContainers();
  });

  it("daemon should receive a codex message and POST events back to the test server", async () => {
    if (!codexAuthContents) {
      console.log("Skipping: ~/.codex/auth.json not found");
      return;
    }
    const threadId = "daemon-lifecycle-thread-id";
    const threadChatId = "daemon-lifecycle-chat-id";

    await sendMessage({
      session: sandbox,
      message: {
        type: "claude",
        agent: "codex",
        agentVersion: 1,
        token: "test-token",
        prompt:
          "Create a file called hello.txt with the content: daemon lifecycle works",
        model: "gpt-5",
        sessionId: null,
        threadId,
        threadChatId,
        transportMode: "legacy",
        permissionMode: "allowAll",
      },
    });

    // Wait for at least one event to arrive at our test server
    await waitFor(() => events.length > 0, { timeoutMs: 60_000 });

    expect(events[0]!.threadId).toBe(threadId);
    expect(events[0]!.threadChatId).toBe(threadChatId);
    expect(events[0]!.messages.length).toBeGreaterThan(0);

    // Wait for a result-type message (agent turn complete)
    await waitFor(
      () => events.some((e) => e.messages.some((m) => m.type === "result")),
      { timeoutMs: 5 * 60_000 },
    );

    const resultEvent = events.find((e) =>
      e.messages.some((m) => m.type === "result"),
    )!;
    const resultMsg = resultEvent.messages.find((m) => m.type === "result")!;
    expect(resultMsg.type).toBe("result");

    // Verify the file was actually created
    const fileContents = await sandbox.readTextFile("/root/repo/hello.txt");
    expect(fileContents).toContain("daemon lifecycle works");
  });
});
