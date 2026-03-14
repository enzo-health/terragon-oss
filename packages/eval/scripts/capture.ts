#!/usr/bin/env tsx

import { resolve } from "path";
import { config } from "dotenv";
// Load .env.local from repo root before any module reads process.env
config({ path: resolve(__dirname, "../../../.env.local") });

import { mkdirSync, writeFileSync } from "fs";

import { FIXTURES_DIR } from "../src/config";
import { createDb } from "../src/db";
import {
  fetchThread,
  fetchThreadChat,
  fetchLoop,
  fetchArtifacts,
  fetchPlanTasks,
  fetchSignals,
  fetchDeepReviewRuns,
  fetchDeepReviewFindings,
  fetchCarmackReviewRuns,
  fetchCarmackReviewFindings,
} from "../src/capture/queries";
import {
  extractUserMessages,
  normalizeSignals,
  normalizeFindings,
  normalizeArtifacts,
  normalizePlanTasks,
  assembleFixture,
} from "../src/capture/normalize";

async function main() {
  const threadId = process.argv[2];
  if (!threadId) {
    console.error("Usage: tsx scripts/capture.ts <threadId>");
    process.exit(1);
  }

  // Read env directly after dotenv.config() — import hoisting means
  // config.ts may have already read an empty process.env at load time
  const dbUrl = process.env.PROD_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (!dbUrl) {
    console.error(
      "No database URL found. Set PROD_DATABASE_URL or DATABASE_URL in .env.local",
    );
    process.exit(1);
  }

  console.log("Connecting to prod database...");
  const db = await createDb(dbUrl);

  try {
    console.log(`Fetching thread ${threadId}...`);
    const thread = await fetchThread(db, threadId);

    console.log("Fetching thread chat...");
    const threadChat = await fetchThreadChat(db, threadId);

    console.log("Fetching SDLC loop...");
    const loop = await fetchLoop(db, threadId);
    const loopId = (loop as any).id as string;

    console.log("Fetching artifacts...");
    const rawArtifacts = await fetchArtifacts(db, loopId);

    console.log("Fetching plan tasks...");
    const rawPlanTasks = await fetchPlanTasks(db, loopId);

    console.log("Fetching signals...");
    const rawSignals = await fetchSignals(db, loopId);

    console.log("Fetching deep review runs & findings...");
    await fetchDeepReviewRuns(db, loopId);
    const rawDeepFindings = await fetchDeepReviewFindings(db, loopId);

    console.log("Fetching carmack review runs & findings...");
    await fetchCarmackReviewRuns(db, loopId);
    const rawCarmackFindings = await fetchCarmackReviewFindings(db, loopId);

    // Extract plan text from plan artifact payload if available
    const planArtifact = rawArtifacts.find(
      (a) => (a.artifactType as string) === "plan",
    );
    const planText = (planArtifact?.payload as any)?.planText ?? "";

    // Normalize all data
    const userMessages = extractUserMessages(threadChat.messages as any);
    const signals = normalizeSignals(rawSignals as any);
    const deepFindings = normalizeFindings(rawDeepFindings as any, "deep");
    const carmackFindings = normalizeFindings(
      rawCarmackFindings as any,
      "carmack",
    );
    const artifacts = normalizeArtifacts(rawArtifacts as any);
    const planTasks = normalizePlanTasks(rawPlanTasks as any);

    // Assemble fixture
    console.log("Assembling fixture...");
    const fixture = assembleFixture({
      threadId,
      thread: thread as any,
      threadChat: threadChat as any,
      loop: loop as any,
      signals,
      deepFindings,
      carmackFindings,
      artifacts,
      planTasks,
      userMessages,
      planText,
    });

    // Write fixture to disk
    const outDir = resolve(FIXTURES_DIR, threadId);
    mkdirSync(outDir, { recursive: true });
    const outPath = resolve(outDir, "fixture.json");
    writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
    console.log(`Fixture written to ${outPath}`);
  } finally {
    console.log("Closing database connection...");
    await (db.$client as any).end();
  }
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
