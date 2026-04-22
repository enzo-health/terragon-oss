#!/usr/bin/env tsx

import type { Browser, BrowserContext, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type ReplayRecordingEvent = {
  wallClockMs: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

type SeededScenarioResponse = {
  scenario: "task-liveness-terminal-vs-stale-workflow";
  userId: string;
  sessionToken: string;
  threadId: string;
  threadChatId: string;
  threadName: string;
  runId: string;
  replayRecording: ReplayRecordingEvent[];
};

type TaskLivenessDebugResponse = {
  summary: string;
  ui: {
    threadChatStatus: string | null;
    deliveryLoopState: string | null;
    effectiveThreadStatus: string | null;
    isWorking: boolean;
    canApplyDeliveryLoopHeadOverride: boolean;
  };
};

type CliOptions = {
  baseUrl: string;
  headed: boolean;
  artifactsDir: string;
  secret: string | null;
  captureFixturePath: string | null;
};

export function parseArgs(argv: string[]): CliOptions {
  let baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  let headed = false;
  let artifactsDir = path.resolve(
    os.tmpdir(),
    "terragon-task-liveness-artifacts",
  );
  let secret = process.env.TASK_LIVENESS_TEST_SECRET ?? null;
  let captureFixturePath = process.env.TASK_LIVENESS_CAPTURE_FIXTURE_PATH
    ? path.resolve(process.env.TASK_LIVENESS_CAPTURE_FIXTURE_PATH)
    : null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url" && argv[i + 1]) {
      baseUrl = argv[++i] ?? baseUrl;
      continue;
    }
    if (arg === "--artifacts-dir" && argv[i + 1]) {
      artifactsDir = path.resolve(argv[++i] ?? artifactsDir);
      continue;
    }
    if (arg === "--secret" && argv[i + 1]) {
      secret = argv[++i] ?? secret;
      continue;
    }
    if (arg === "--capture-fixture-path" && argv[i + 1]) {
      captureFixturePath = path.resolve(argv[++i] ?? "");
      continue;
    }
    if (arg === "--headed") {
      headed = true;
    }
  }

  return {
    baseUrl,
    headed,
    artifactsDir,
    secret,
    captureFixturePath,
  };
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${input}\n${body}`);
  }
  return (await response.json()) as T;
}

function toJsonl(events: ReplayRecordingEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

export async function writeFailureArtifacts(params: {
  artifactsDir: string;
  screenshotPng: Buffer | null;
  scenario: SeededScenarioResponse | null;
  debugPayload: TaskLivenessDebugResponse | null;
  replayRecordingJsonl: string | null;
  failureMessage: string;
  captureFixturePath: string | null;
  failureStep: string;
  baseUrl: string;
}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(params.artifactsDir, timestamp);
  await fs.mkdir(runDir, { recursive: true });

  await fs.writeFile(
    path.join(runDir, "failure.txt"),
    `${params.failureMessage}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(runDir, "failure-context.json"),
    `${JSON.stringify(
      {
        failureStep: params.failureStep,
        baseUrl: params.baseUrl,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (params.scenario) {
    await fs.writeFile(
      path.join(runDir, "scenario.json"),
      `${JSON.stringify(params.scenario, null, 2)}\n`,
      "utf8",
    );
  }
  if (params.debugPayload) {
    await fs.writeFile(
      path.join(runDir, "liveness-debug.json"),
      `${JSON.stringify(params.debugPayload, null, 2)}\n`,
      "utf8",
    );
  }

  if (params.replayRecordingJsonl) {
    await fs.writeFile(
      path.join(runDir, "daemon-event-recording.jsonl"),
      params.replayRecordingJsonl,
      "utf8",
    );

    if (params.captureFixturePath) {
      await fs.mkdir(path.dirname(params.captureFixturePath), {
        recursive: true,
      });
      await fs.writeFile(
        params.captureFixturePath,
        params.replayRecordingJsonl,
        "utf8",
      );
      console.error(
        `[task-liveness-e2e] replay fixture updated: ${params.captureFixturePath}`,
      );
    }
  }

  if (params.screenshotPng) {
    await fs.writeFile(path.join(runDir, "browser.png"), params.screenshotPng);
  }

  console.error(`[task-liveness-e2e] failure artifacts: ${runDir}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let failureStep = "bootstrap";
  let scenario: SeededScenarioResponse | null = null;
  let replayRecordingJsonl: string | null = null;
  let debugPayload: TaskLivenessDebugResponse | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    if (!options.secret) {
      throw new Error(
        "TASK_LIVENESS_TEST_SECRET is required. Set env var or pass --secret.",
      );
    }

    failureStep = "seed_scenario";
    const scenarioUrl = `${options.baseUrl}/api/test/task-liveness-scenario`;
    scenario = await fetchJson<SeededScenarioResponse>(scenarioUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Terragon-Secret": options.secret,
      },
      body: "{}",
    });
    replayRecordingJsonl = toJsonl(scenario.replayRecording);

    failureStep = "launch_browser";
    browser = await chromium.launch({
      headless: !options.headed,
    });
    context = await browser.newContext({
      extraHTTPHeaders: {
        Authorization: `Bearer ${scenario.sessionToken}`,
        "X-Terragon-Secret": options.secret,
      },
    });
    page = await context.newPage();

    failureStep = "open_task_page";
    const taskUrl = `${options.baseUrl}/task/${scenario.threadId}`;
    await page.goto(taskUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(new RegExp(`/task/${scenario.threadId}$`), {
      timeout: 15_000,
    });
    await page.waitForSelector("body", { timeout: 15_000 });

    const bodyText = await page.locator("body").innerText();
    if (!bodyText.includes(scenario.threadName)) {
      throw new Error(
        `expected seeded task name "${scenario.threadName}" to render on page ${taskUrl}`,
      );
    }
    if (bodyText.includes("Assistant is working")) {
      throw new Error(
        `stale UI regression: found "Assistant is working" on terminal scenario task ${scenario.threadId}`,
      );
    }

    failureStep = "read_debug_payload";
    const debugUrl = `${options.baseUrl}/api/test/task-liveness-debug/${scenario.threadId}`;
    debugPayload = await fetchJson<TaskLivenessDebugResponse>(debugUrl, {
      headers: {
        Authorization: `Bearer ${scenario.sessionToken}`,
        "X-Terragon-Secret": options.secret,
      },
    });

    if (debugPayload.ui.isWorking) {
      throw new Error(
        `expected non-working debug payload, got isWorking=true (${debugPayload.summary})`,
      );
    }
    if (debugPayload.ui.effectiveThreadStatus !== "complete") {
      throw new Error(
        `expected effectiveThreadStatus=complete, got ${String(debugPayload.ui.effectiveThreadStatus)}`,
      );
    }
    if (debugPayload.ui.canApplyDeliveryLoopHeadOverride) {
      throw new Error(
        "expected stale workflow head override to be rejected, got canApplyDeliveryLoopHeadOverride=true",
      );
    }

    console.log(
      `[task-liveness-e2e] PASS ${scenario.threadId} (${debugPayload.summary})`,
    );
  } catch (error) {
    const screenshotPng =
      page !== null ? await page.screenshot({ fullPage: true }) : null;
    await writeFailureArtifacts({
      artifactsDir: options.artifactsDir,
      screenshotPng,
      scenario,
      debugPayload,
      replayRecordingJsonl,
      failureMessage:
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      captureFixturePath: options.captureFixturePath,
      failureStep,
      baseUrl: options.baseUrl,
    });
    throw error;
  } finally {
    if (context) {
      await context.close();
    }
    if (browser) {
      await browser.close();
    }
  }
}

const entrypointPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (entrypointPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
