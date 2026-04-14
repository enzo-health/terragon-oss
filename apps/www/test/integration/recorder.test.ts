import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRecorderServer } from "./recorder";
import type { RecordedDaemonEvent } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("could not bind port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

function httpPost(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 200,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function startServer(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve) => server.listen(port, resolve));
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRecorderServer", () => {
  let upstreamServer: http.Server;
  let recorderServer: http.Server;
  let upstreamPort: number;
  let recorderPort: number;
  let outFile: string;
  let upstreamHitCount: number;

  beforeEach(async () => {
    upstreamHitCount = 0;

    // Spin up a fake upstream that echoes back 200 OK
    upstreamServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        upstreamHitCount++;
        // Drain body to release the request, but value is unused in tests.
        Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    upstreamPort = await getAvailablePort();
    recorderPort = await getAvailablePort();

    outFile = path.join(os.tmpdir(), `recorder-test-${Date.now()}.jsonl`);

    await startServer(upstreamServer, upstreamPort);

    recorderServer = createRecorderServer({
      forwardTo: `http://127.0.0.1:${upstreamPort}`,
      out: outFile,
      startTime: Date.now(),
    });
    await startServer(recorderServer, recorderPort);
  });

  afterEach(async () => {
    await closeServer(recorderServer);
    await closeServer(upstreamServer);
    if (fs.existsSync(outFile)) {
      fs.unlinkSync(outFile);
    }
  });

  it("forwards the POST to the upstream server", async () => {
    const testBody = JSON.stringify({
      threadId: "t-001",
      threadChatId: "tc-001",
      messages: [],
      timezone: "UTC",
    });

    const response = await httpPost(recorderPort, testBody);

    expect(response.status).toBe(200);
    expect(upstreamHitCount).toBe(1);
  });

  it("writes the captured event to the JSONL file", async () => {
    const testBody = JSON.stringify({
      threadId: "t-abc",
      threadChatId: "tc-abc",
      messages: [
        {
          type: "custom-stop",
          session_id: null,
          duration_ms: 100,
        },
      ],
      timezone: "UTC",
    });

    await httpPost(recorderPort, testBody, {
      "x-daemon-version": "1",
    });

    expect(fs.existsSync(outFile)).toBe(true);

    const lines = fs
      .readFileSync(outFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);

    const event = JSON.parse(lines[0]!) as RecordedDaemonEvent;
    expect(event.body.threadId).toBe("t-abc");
    expect(event.body.threadChatId).toBe("tc-abc");
    expect(event.body.messages[0]?.type).toBe("custom-stop");
  });

  it("includes request headers in the captured event", async () => {
    const testBody = JSON.stringify({
      threadId: "t-hdr",
      threadChatId: "tc-hdr",
      messages: [],
      timezone: "UTC",
    });

    await httpPost(recorderPort, testBody, {
      "x-daemon-version": "1",
      "x-daemon-capabilities": "daemon_event_envelope_v2",
    });

    const lines = fs
      .readFileSync(outFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const event = JSON.parse(lines[0]!) as RecordedDaemonEvent;

    expect(event.headers["x-daemon-version"]).toBe("1");
    expect(event.headers["x-daemon-capabilities"]).toBe(
      "daemon_event_envelope_v2",
    );
  });

  it("wallClockMs is a non-negative number", async () => {
    const testBody = JSON.stringify({
      threadId: "t-ts",
      threadChatId: "tc-ts",
      messages: [],
      timezone: "UTC",
    });

    await httpPost(recorderPort, testBody);

    const lines = fs
      .readFileSync(outFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const event = JSON.parse(lines[0]!) as RecordedDaemonEvent;

    expect(typeof event.wallClockMs).toBe("number");
    expect(event.wallClockMs).toBeGreaterThanOrEqual(0);
  });

  it("appends multiple events in separate JSONL lines", async () => {
    const makeBody = (threadId: string) =>
      JSON.stringify({
        threadId,
        threadChatId: "tc-multi",
        messages: [],
        timezone: "UTC",
      });

    await httpPost(recorderPort, makeBody("thread-A"));
    await httpPost(recorderPort, makeBody("thread-B"));

    const lines = fs
      .readFileSync(outFile, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);

    const [eventA, eventB] = lines.map(
      (l) => JSON.parse(l!) as RecordedDaemonEvent,
    );
    expect(eventA?.body.threadId).toBe("thread-A");
    expect(eventB?.body.threadId).toBe("thread-B");
  });

  it("relays the upstream response status to the caller", async () => {
    const testBody = JSON.stringify({
      threadId: "t-relay",
      threadChatId: "tc-relay",
      messages: [],
      timezone: "UTC",
    });
    const response = await httpPost(recorderPort, testBody);
    // Upstream returns 200
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });
});
