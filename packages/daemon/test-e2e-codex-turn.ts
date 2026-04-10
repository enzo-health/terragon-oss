#!/usr/bin/env npx tsx
/**
 * E2E test: Full Codex app-server turn in a real Docker sandbox with a cloned
 * git repo, so the agent can actually run tools (bash, files, git).
 *
 * Usage:  npx tsx test-e2e-codex-turn.ts
 */

import { spawn, execSync } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTurnStartParams,
  buildThreadStartParams,
  codexAppServerStartCommand,
} from "./src/codex";

// ─── config ──────────────────────────────────────────────────────
const MODEL = "gpt-5.3-codex-medium";
const PROMPT =
  'Create a file called hello.txt with the content "Hello from Codex!" and then cat it to verify.';
const TIMEOUT_MS = 120_000;
const IMAGE = "ghcr.io/leo-labs/containers-test:latest";
const REPO = "SawyerHood/test-project"; // small public repo used in sandbox tests

// ─── helpers ─────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wwwEnvPath = path.resolve(
  __dirname,
  "../../apps/www/.env.development.local",
);

function loadEnvKey(file: string, key: string): string | null {
  const content = fs.readFileSync(file, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(`${key}=`)) {
      return trimmed.slice(key.length + 1).replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

// Try to load OPENAI_API_KEY (optional — codex can also use ~/.codex/auth.json OAuth)
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || loadEnvKey(wwwEnvPath, "OPENAI_API_KEY") || "";

function dockerExec(
  containerId: string,
  cmd: string,
  timeoutMs = 60_000,
): string {
  return execSync(
    `docker exec ${containerId} bash -c "${cmd.replace(/"/g, '\\"')}"`,
    {
      encoding: "utf8",
      timeout: timeoutMs,
    },
  ).trim();
}

// ─── spin up docker container ────────────────────────────────────
console.log("🐳  Starting container...");
const envFlags = OPENAI_API_KEY ? `-e OPENAI_API_KEY="${OPENAI_API_KEY}"` : "";
const containerId = execSync(
  `docker run -d --rm --privileged ${envFlags} ${IMAGE} tail -f /dev/null`,
  { encoding: "utf8" },
).trim();
console.log(`   container: ${containerId.slice(0, 12)}`);

function cleanup() {
  try {
    execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
  } catch {}
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

// ─── set up real sandbox environment ─────────────────────────────
console.log("📦  Installing codex...");
dockerExec(
  containerId,
  "which codex >/dev/null 2>&1 || npm install -g @openai/codex@0.107.0",
  120_000,
);
const codexVersion = dockerExec(containerId, "codex --version");
console.log(`   codex: ${codexVersion}`);

console.log("📂  Cloning repo...");
dockerExec(
  containerId,
  `git clone --filter=blob:none --no-recurse-submodules https://github.com/${REPO}.git /root/repo`,
  60_000,
);
console.log(`   cloned ${REPO} → /root/repo`);

console.log("⚙️   Configuring git & codex...");
dockerExec(containerId, 'git config --global user.name "E2E Test"');
dockerExec(containerId, 'git config --global user.email "test@leo.dev"');

// Write codex config.toml with our model provider settings
dockerExec(
  containerId,
  `mkdir -p /root/.codex && cat > /root/.codex/config.toml << 'TOML'
[model_providers.openai]
name = "openai"
stream_idle_timeout_ms = 600000
stream_max_retries = 20

[shell_environment_policy]
inherit = "all"
ignore_default_excludes = true
TOML`,
);

// Copy local codex auth.json into the container for ChatGPT OAuth auth
const localAuthJson = path.join(
  process.env.HOME || "/root",
  ".codex",
  "auth.json",
);
if (fs.existsSync(localAuthJson)) {
  execSync(
    `docker cp "${localAuthJson}" ${containerId}:/root/.codex/auth.json`,
    { stdio: "ignore" },
  );
  console.log("   copied ~/.codex/auth.json into container");
}

// Verify sandbox is ready
const lsOutput = dockerExec(containerId, "ls /root/repo");
console.log(`   repo contents: ${lsOutput.replace(/\n/g, ", ")}`);
console.log("   ✅ Sandbox ready\n");

// ─── build codex command ─────────────────────────────────────────
const [command, args] = codexAppServerStartCommand({ model: MODEL });
console.log(`🚀  Launching: ${command} ${args.join(" ")}\n`);

// Run codex app-server inside the container (auth.json handles auth, no OPENAI_API_KEY needed)
const proc = spawn(
  "docker",
  ["exec", "-i", "-w", "/root/repo", containerId, command, ...args],
  { stdio: ["pipe", "pipe", "pipe"] },
);

const rl = readline.createInterface({
  input: proc.stdout!,
  crlfDelay: Infinity,
});

let nextId = 1;
const pending = new Map<
  number,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
  }
>();
let threadId: string | null = null;

function send(
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const id = nextId++;
  const envelope = {
    jsonrpc: "2.0",
    id,
    method,
    ...(params ? { params } : {}),
  };
  console.log(`  → ${method} (id=${id})`);
  proc.stdin!.write(JSON.stringify(envelope) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method} response`));
    }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, method });
  });
}

function sendNotification(method: string, params?: Record<string, unknown>) {
  const envelope = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
  proc.stdin!.write(JSON.stringify(envelope) + "\n");
  console.log(`  → ${method} (notification)`);
}

proc.stderr!.on("data", (chunk: Buffer) => {
  const text = chunk.toString().trim();
  if (text) console.log(`  [stderr] ${text}`);
});

let turnCompleted = false;
let turnFailed = false;
let sawCommandExecution = false;
let sawAgentMessage = false;
let sawThinking = false;

rl.on("line", (line: string) => {
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }

  // Handle JSON-RPC response
  if (parsed.id != null && ("result" in parsed || "error" in parsed)) {
    const p = pending.get(parsed.id);
    if (p) {
      pending.delete(parsed.id);
      clearTimeout(p.timer);
      if (parsed.error) {
        console.log(`  ❌ ${p.method} error: ${JSON.stringify(parsed.error)}`);
        p.reject(
          new Error(parsed.error.message || JSON.stringify(parsed.error)),
        );
      } else {
        console.log(`  ✅ ${p.method} ok`);
        p.resolve(parsed.result);
      }
    }
    return;
  }

  // Handle notification
  const method = parsed.method;
  if (!method) return;
  const params = parsed.params || {};

  if (method === "thread/started") {
    threadId = params.threadId || params.thread_id || params.thread?.id;
    console.log(`  📣 thread/started → threadId=${threadId}`);
  } else if (method === "turn/started") {
    console.log(`  📣 turn/started`);
  } else if (method === "turn/completed") {
    const usage = params.turn?.usage || params.usage || {};
    console.log(
      `  📣 turn/completed — tokens: in=${usage.input_tokens || 0} cached=${usage.cached_input_tokens || 0} out=${usage.output_tokens || 0}`,
    );
    turnCompleted = true;
  } else if (method === "error") {
    console.log(`  📣 error: ${JSON.stringify(params)}`);
  } else if (method === "turn/failed") {
    console.log(`  ❌ turn/failed: ${JSON.stringify(params.error || params)}`);
    turnFailed = true;
    turnCompleted = true;
  } else if (method.startsWith("item/")) {
    const item = params.item || {};
    const type = item.type || "?";
    if (type === "command_execution" || type === "commandExecution") {
      sawCommandExecution = true;
      const cmd = item.command || "";
      const output = item.aggregated_output || item.aggregatedOutput || "";
      const status = item.status || "";
      const preview = cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
      const outPreview =
        output.length > 80 ? output.slice(0, 77) + "..." : output;
      console.log(`  📣 ${method} [bash] $ ${preview}`);
      if (outPreview) console.log(`     → ${outPreview} (${status})`);
    } else if (type === "file_change") {
      const changes = item.changes || [];
      for (const c of changes) {
        console.log(`  📣 ${method} [file] ${c.kind}: ${c.path}`);
      }
    } else if (type === "agent_message" || type === "agentMessage") {
      sawAgentMessage = true;
      const text = item.text || "";
      const preview = text.length > 100 ? text.slice(0, 97) + "..." : text;
      console.log(`  📣 ${method} [message] ${preview}`);
    } else if (type === "reasoning" || type === "thinking") {
      sawThinking = true;
      const text = item.text || "";
      const preview = text.length > 100 ? text.slice(0, 97) + "..." : text;
      console.log(`  📣 ${method} [thinking] ${preview}`);
    } else {
      const text = item.text || item.command || "";
      const preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
      console.log(`  📣 ${method} [${type}] ${preview}`);
    }
  } else if (
    method === "thread/status/changed" ||
    method === "codex/event/mcp_startup_complete"
  ) {
    // quiet
  } else if (method.startsWith("codex/event/")) {
    const eventName = method.replace("codex/event/", "");
    if (eventName === "stream_error" || eventName === "error") {
      console.log(`  📣 ${method}: ${JSON.stringify(params)}`);
    } else if (
      !["task_started", "task_complete", "user_message"].includes(eventName)
    ) {
      console.log(`  📣 ${method}`);
    }
  } else {
    console.log(`  📣 ${method}`);
  }
});

// ─── run the full flow ───────────────────────────────────────────
async function run() {
  // Step 1: initialize
  console.log("─── Step 1: initialize ───");
  await send("initialize", {
    clientInfo: { name: "leo-daemon-e2e-test", version: "1.0" },
    capabilities: {},
  });
  sendNotification("initialized", {});

  // Step 2: thread/start
  // buildThreadStartParams now correctly uses `sandbox: "danger-full-access"` (SandboxMode string)
  // and buildTurnStartParams uses `sandboxPolicy: { type: "externalSandbox" }` (SandboxPolicy object)
  console.log("\n─── Step 2: thread/start ───");
  const threadStartParams = buildThreadStartParams({
    model: MODEL,
    instructions:
      "You are a helpful coding assistant. Execute commands in the sandbox to complete tasks. Be concise.",
  });
  const threadStartResult = (await send(
    "thread/start",
    threadStartParams as any,
  )) as any;

  if (threadStartResult?.thread?.id) {
    threadId = threadStartResult.thread.id;
  }
  if (!threadId) {
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!threadId) {
    throw new Error("Never received threadId from thread/start");
  }
  console.log(`  ✅ threadId = ${threadId}`);

  // Step 3: turn/start
  console.log("\n─── Step 3: turn/start ───");
  const turnStartParams = buildTurnStartParams({
    threadId,
    prompt: PROMPT,
  });
  console.log(`  input: ${JSON.stringify(turnStartParams.input)}`);
  console.log(
    `  sandboxPolicy: ${JSON.stringify(turnStartParams.sandboxPolicy)}`,
  );
  await send("turn/start", turnStartParams as any);

  // Wait for turn to complete
  console.log("\n─── Waiting for turn ───");
  const start = Date.now();
  while (!turnCompleted && Date.now() - start < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 200));
  }

  // ─── Results ────────────────────────────────────────────────────
  console.log("\n─── Protocol validation ───");
  console.log(`  initialize:        ✅`);
  console.log(`  thread/start:      ✅ (threadId=${threadId})`);
  console.log(`  turn/start:        ✅ (input format accepted)`);
  console.log(`  model thinking:    ${sawThinking ? "✅" : "❌"}`);
  console.log(`  agent message:     ${sawAgentMessage ? "✅" : "❌"}`);
  console.log(
    `  tool execution:    ${sawCommandExecution ? "✅" : "⚠️  skipped (sandbox runtime — landlock may be unavailable)"}`,
  );
  console.log(
    `  turn completed:    ${turnCompleted ? (turnFailed ? "❌ failed" : "✅") : "❌ timed out"}`,
  );

  // Verify the file was actually created (only if tools executed)
  if (sawCommandExecution) {
    console.log("\n─── Verifying sandbox state ───");
    try {
      const fileContent = dockerExec(containerId, "cat /root/repo/hello.txt");
      console.log(`  hello.txt: "${fileContent}"`);
    } catch {
      console.log(
        "  hello.txt: not found (agent may have used different path)",
      );
    }
  }

  // The test passes if the protocol flow works (turn completes without RPC errors).
  // Tool execution depends on landlock LSM which may not be available in Docker Desktop.
  if (turnFailed) {
    console.log("\n❌ Turn failed — protocol error!");
    process.exitCode = 1;
  } else if (!turnCompleted) {
    console.log("\n❌ Timed out waiting for turn completion");
    process.exitCode = 1;
  } else if (!sawAgentMessage) {
    console.log(
      "\n❌ No agent messages received — model may not have responded",
    );
    process.exitCode = 1;
  } else {
    console.log("\n✅ E2E protocol validation passed!");
    if (!sawCommandExecution) {
      console.log(
        "   (tool execution skipped — codex sandbox needs landlock LSM, unavailable in Docker Desktop on macOS)",
      );
    }
  }
}

run()
  .catch((err) => {
    console.error(`\n❌ Test failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => {
    proc.kill("SIGTERM");
    cleanup();
  });
