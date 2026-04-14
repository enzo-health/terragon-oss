#!/usr/bin/env tsx
/**
 * Recorder — local HTTP proxy that captures daemon-event POST bodies.
 *
 * Usage:
 *   pnpm recorder --port 9001 --forward-to http://localhost:3000/api/daemon-event --out /tmp/session.jsonl
 *
 * The proxy:
 *   1. Listens on --port for incoming POST requests.
 *   2. Forwards each request body + headers to --forward-to.
 *   3. Appends a RecordedDaemonEvent JSON line to --out.
 *   4. Returns the upstream response (status + body) to the original caller.
 */

import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import type { RecordedDaemonEvent } from "./types";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  port: number;
  forwardTo: string;
  out: string;
} {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--") && i + 1 < argv.length) {
      const key = arg.slice(2);
      args[key] = argv[++i] ?? "";
    }
  }
  const port = parseInt(args["port"] ?? "9001", 10);
  const forwardTo =
    args["forward-to"] ?? "http://localhost:3000/api/daemon-event";
  const out = args["out"] ?? path.join(process.cwd(), "recording.jsonl");
  return { port, forwardTo, out };
}

// ---------------------------------------------------------------------------
// Core proxy function (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Forwards rawBody to upstreamUrl with the provided headers, returns the
 * upstream response status and body text.
 */
export async function forwardRequest(
  upstreamUrl: string,
  rawBody: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(upstreamUrl);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;

    const reqHeaders: Record<string, string> = {
      ...headers,
      "content-length": String(rawBody.length),
    };
    // Remove hop-by-hop headers that shouldn't be forwarded
    delete reqHeaders["host"];
    delete reqHeaders["transfer-encoding"];

    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search ?? ""),
        method: "POST",
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 200,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.write(rawBody);
    req.end();
  });
}

/**
 * Creates the proxy HTTP server. The server is not started — call
 * server.listen(port) yourself.
 */
export function createRecorderServer(options: {
  forwardTo: string;
  out: string;
  startTime?: number;
}): http.Server {
  const startTime = options.startTime ?? Date.now();

  return http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed — recorder only handles POST");
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks);
      const wallClockMs = Date.now() - startTime;

      // Collect request headers (lower-cased, string values only)
      const capturedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          capturedHeaders[key] = value;
        } else if (Array.isArray(value)) {
          capturedHeaders[key] = value.join(", ");
        }
      }

      // Forward to upstream
      let upstreamStatus = 502;
      let upstreamBody = "";
      try {
        const result = await forwardRequest(
          options.forwardTo,
          rawBody,
          capturedHeaders,
        );
        upstreamStatus = result.status;
        upstreamBody = result.body;
      } catch (err) {
        console.error("[recorder] upstream error:", err);
        res.writeHead(502);
        res.end("Bad Gateway");
        return;
      }

      // Parse body for recording (best-effort — fall back to empty messages)
      let parsedBody: RecordedDaemonEvent["body"];
      try {
        parsedBody = JSON.parse(rawBody.toString("utf8"));
      } catch {
        parsedBody = {
          threadId: "unknown",
          threadChatId: "unknown",
          messages: [],
          timezone: "UTC",
        };
      }

      const event: RecordedDaemonEvent = {
        wallClockMs,
        body: parsedBody,
        headers: capturedHeaders,
      };

      // Append to JSONL file
      fs.appendFileSync(options.out, JSON.stringify(event) + "\n", "utf8");

      // Relay upstream response
      res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
      res.end(upstreamBody);
    });
  });
}

// ---------------------------------------------------------------------------
// CLI entry point (only runs when invoked directly via tsx/ts-node)
// ---------------------------------------------------------------------------

if (
  process.argv[1] &&
  (process.argv[1].endsWith("recorder.ts") ||
    process.argv[1].endsWith("recorder.js"))
) {
  const { port, forwardTo, out } = parseArgs(process.argv.slice(2));

  // Ensure output directory exists
  const outDir = path.dirname(path.resolve(out));
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const server = createRecorderServer({ forwardTo, out });
  server.listen(port, () => {
    console.log(`[recorder] listening on port ${port}`);
    console.log(`[recorder] forwarding to ${forwardTo}`);
    console.log(`[recorder] writing JSONL to ${out}`);
  });
}
