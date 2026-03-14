#!/usr/bin/env tsx
/**
 * Capture a full thread trace from prod DB into an EvalFixture.
 *
 * Usage:
 *   pnpm -C packages/eval capture <threadId>
 *   tsx scripts/capture.ts <threadId>
 */

import { resolve } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { config } from "dotenv";

// Load .env.local from repo root
config({ path: resolve(__dirname, "../../../.env.local") });

import { createDb } from "../src/db";
import { FIXTURES_DIR, PROD_DATABASE_URL } from "../src/config";
import {
  fetchThread,
  fetchThreadChat,
  fetchLoop,
  fetchArtifacts,
  fetchPlanTasks,
  fetchSignals,
  fetchDeepReviewFindings,
  fetchCarmackReviewFindings,
  fetchAgentRunContexts,
  extractUserMessages,
  normalizeSignals,
  normalizeFindings,
  normalizeArtifacts,
  normalizePlanTasks,
  assembleFixture,
} from "../src/capture";

async function main() {
  const threadId = process.argv[2];
  if (!threadId) {
    console.error("Usage: tsx scripts/capture.ts <threadId>");
    process.exit(1);
  }

  if (!PROD_DATABASE_URL) {
    console.error(
      "No database URL found. Set PROD_DATABASE_URL or DATABASE_URL in .env.local",
    );
    process.exit(1);
  }

  console.log(`Connecting to database...`);
  const db = createDb(PROD_DATABASE_URL);

  console.log(`Fetching thread ${threadId}...`);

  // Fetch thread + threadChat
  const threadRow = await fetchThread(db, threadId);
  const threadChatRow = await fetchThreadChat(db, threadId);

  // Fetch loop
  const loopRow = await fetchLoop(db, threadId);
  const loopId = loopRow.id;

  // Fetch all related data in parallel
  const [
    artifactRows,
    planTaskRows,
    signalRows,
    deepFindingRows,
    carmackFindingRows,
    agentRunRows,
  ] = await Promise.all([
    fetchArtifacts(db, loopId),
    fetchPlanTasks(db, loopId),
    fetchSignals(db, loopId),
    fetchDeepReviewFindings(db, loopId),
    fetchCarmackReviewFindings(db, loopId),
    fetchAgentRunContexts(db, threadId),
  ]);

  // Extract user messages from thread_chat or thread messages
  const messages = threadChatRow.messages ?? threadRow.messages ?? [];
  const userMessages = extractUserMessages(messages);

  // Normalize
  const signals = normalizeSignals(signalRows);
  const deepFindings = normalizeFindings(deepFindingRows, "deep");
  const carmackFindings = normalizeFindings(carmackFindingRows, "carmack");
  const artifacts = normalizeArtifacts(artifactRows);
  const planTasks = normalizePlanTasks(planTaskRows);

  // Extract plan text from the active plan artifact
  let planText = "";
  if (loopRow.activePlanArtifactId) {
    const planArtifact = artifactRows.find(
      (a: { id: string }) => a.id === loopRow.activePlanArtifactId,
    );
    if (planArtifact?.payload && typeof planArtifact.payload === "object") {
      const payload = planArtifact.payload as Record<string, unknown>;
      if (typeof payload.planText === "string") {
        planText = payload.planText;
      }
    }
  }

  // Assemble fixture
  const fixture = assembleFixture({
    threadId,
    thread: threadRow,
    threadChat: threadChatRow,
    loop: loopRow,
    signals,
    deepFindings,
    carmackFindings,
    artifacts,
    planTasks,
    userMessages,
    planText,
  });

  // Write to fixtures/<threadId-prefix>/fixture.json
  const prefix = threadId.slice(0, 8);
  const fixtureDir = resolve(FIXTURES_DIR, prefix);
  mkdirSync(fixtureDir, { recursive: true });

  const outPath = resolve(fixtureDir, "fixture.json");
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");

  // Print summary
  console.log(`\n--- Capture Summary ---`);
  console.log(`Thread:          ${threadId}`);
  console.log(`ThreadChat:      ${threadChatRow.id}`);
  console.log(`Loop:            ${loopId}`);
  console.log(
    `Agent:           ${threadChatRow.agent} v${threadChatRow.agentVersion}`,
  );
  console.log(`Repo:            ${threadRow.githubRepoFullName}`);
  console.log(`Final state:     ${loopRow.state}`);
  console.log(`Signals:         ${signals.length}`);
  console.log(`Plan tasks:      ${planTasks.length}`);
  console.log(`Artifacts:       ${artifacts.length}`);
  console.log(`Deep findings:   ${deepFindings.length}`);
  console.log(`Carmack findings:${carmackFindings.length}`);
  console.log(`Agent runs:      ${agentRunRows.length}`);
  console.log(`User messages:   ${userMessages.length}`);
  console.log(`Fix cycles:      ${fixture.baselineMetrics.fixCycles}`);
  console.log(
    `Convergence:     ${fixture.baselineMetrics.convergenceRate.toFixed(3)}`,
  );
  console.log(
    `Duration:        ${(fixture.baselineMetrics.totalDurationMs / 1000).toFixed(1)}s`,
  );
  console.log(`Succeeded:       ${fixture.baselineMetrics.succeeded}`);
  console.log(`\nWritten to: ${outPath}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
