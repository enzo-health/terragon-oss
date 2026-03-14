#!/usr/bin/env tsx
/**
 * Replay a captured EvalFixture through the delivery loop state machine
 * against a local test database.
 *
 * Usage:
 *   tsx scripts/replay.ts <fixtureId> [--mode signal]
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { FIXTURES_DIR, RUNS_DIR, TEST_DATABASE_URL } from "../src/config";
import {
  loadSharedModules,
  seedFromFixture,
  cleanupSeededState,
  replaySignal,
  computeMetrics,
} from "../src/replay";
import type { SeededState } from "../src/replay";
import type { EvalFixture, EvalRun, StateTransition } from "../src/types";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const fixtureId = process.argv[2];
  if (!fixtureId) {
    console.error("Usage: tsx scripts/replay.ts <fixtureId> [--mode signal]");
    process.exit(1);
  }

  // Parse --mode flag (only "signal" supported)
  const modeIdx = process.argv.indexOf("--mode");
  const mode =
    modeIdx !== -1 ? (process.argv[modeIdx + 1] ?? "signal") : "signal";
  if (mode !== "signal") {
    console.error(`Unsupported mode: ${mode}. Only "signal" is supported.`);
    process.exit(1);
  }

  // 1. Load fixture from fixtures/<fixtureId>/fixture.json
  const fixturePath = resolve(FIXTURES_DIR, fixtureId, "fixture.json");
  if (!existsSync(fixturePath)) {
    console.error(`Fixture not found: ${fixturePath}`);
    process.exit(1);
  }

  const fixture: EvalFixture = JSON.parse(readFileSync(fixturePath, "utf-8"));
  console.log(
    `Loaded fixture ${fixtureId} (${fixture.signals.length} signals)`,
  );

  // 2. Verify test DB is reachable
  try {
    execSync(
      `node -e "const net=require('net');const s=net.connect(15432,'localhost',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1))"`,
      { stdio: "pipe", timeout: 5000 },
    );
  } catch {
    console.error(
      "ERROR: Test DB not available on port 15432.\n" +
        "Start it with: docker compose up (from repo root)",
    );
    process.exit(1);
  }

  // 3. Import shared modules via dynamic loader
  const shared = await loadSharedModules();

  // 4. Connect to test DB (port 15432)
  const db = shared.createDb(TEST_DATABASE_URL);
  console.log("Connected to test DB");

  const startedAt = new Date().toISOString();
  const replayStart = Date.now();
  let seeded: SeededState | null = null;

  try {
    // 5. Seed DB with user, session, thread, threadChat, and SDLC loop
    seeded = await seedFromFixture({ db, shared, fixture });
    console.log(`Seeded: thread=${seeded.threadId} loop=${seeded.loopId}`);

    // 6. Walk through fixture signals, replaying each through the state machine
    const stateTrace: StateTransition[] = [];
    const results = [];

    for (const signal of fixture.signals) {
      const result = await replaySignal({
        db,
        shared,
        seeded,
        signal,
        gateEvents: fixture.gateEvents ?? [],
      });
      results.push(result);

      stateTrace.push({
        loopVersion: result.loopVersion,
        previousState: result.previousState,
        nextState: result.nextState,
        event: result.transitionEvent ?? signal.causeType,
        timestamp: new Date().toISOString(),
        fixAttemptCount: result.fixAttemptCount,
      });

      const errorSuffix = result.error ? ` [ERROR: ${result.error}]` : "";
      console.log(
        `  [${signal.index}] ${signal.causeType}: ${result.previousState} -> ${result.nextState}${errorSuffix}`,
      );
    }

    const totalDurationMs = Date.now() - replayStart;
    const completedAt = new Date().toISOString();

    // 7. Query findings from DB (written by gate event replay)
    const deepFindings = await db
      .select({
        id: shared.schema.sdlcDeepReviewFinding.id,
        title: shared.schema.sdlcDeepReviewFinding.title,
        severity: shared.schema.sdlcDeepReviewFinding.severity,
        category: shared.schema.sdlcDeepReviewFinding.category,
        isBlocking: shared.schema.sdlcDeepReviewFinding.isBlocking,
        headSha: shared.schema.sdlcDeepReviewFinding.headSha,
      })
      .from(shared.schema.sdlcDeepReviewFinding)
      .where(
        (shared.eq as any)(
          shared.schema.sdlcDeepReviewFinding.loopId,
          seeded.loopId,
        ),
      );

    const carmackFindings = await db
      .select({
        id: shared.schema.sdlcCarmackReviewFinding.id,
        title: shared.schema.sdlcCarmackReviewFinding.title,
        severity: shared.schema.sdlcCarmackReviewFinding.severity,
        category: shared.schema.sdlcCarmackReviewFinding.category,
        isBlocking: shared.schema.sdlcCarmackReviewFinding.isBlocking,
        headSha: shared.schema.sdlcCarmackReviewFinding.headSha,
      })
      .from(shared.schema.sdlcCarmackReviewFinding)
      .where(
        (shared.eq as any)(
          shared.schema.sdlcCarmackReviewFinding.loopId,
          seeded.loopId,
        ),
      );

    const allFindings = [...deepFindings, ...carmackFindings];
    const blockingFindings = allFindings.filter((f) => f.isBlocking);
    const uniqueTitles = new Set(allFindings.map((f) => f.title));

    // Check for cross-reviewer duplicates (same title in both deep + carmack)
    const deepTitles = new Set(deepFindings.map((f) => f.title));
    const carmackTitles = new Set(carmackFindings.map((f) => f.title));
    let crossReviewerDuplicates = 0;
    for (const t of deepTitles) {
      if (carmackTitles.has(t)) crossReviewerDuplicates++;
    }

    // 8. Compute metrics from the state trace
    const metrics = computeMetrics({
      results,
      trace: stateTrace,
      totalDurationMs,
    });

    // Override finding metrics with real data from DB
    metrics.totalFindings = allFindings.length;
    metrics.blockingFindings = blockingFindings.length;
    metrics.uniqueRootCauses = uniqueTitles.size;
    metrics.signalToNoiseRatio =
      allFindings.length > 0 ? uniqueTitles.size / allFindings.length : 0;
    metrics.crossReviewerDuplicates = crossReviewerDuplicates;

    // 9. Get code version via git
    let codeVersion = "unknown";
    try {
      codeVersion = execSync("git rev-parse HEAD", {
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
    } catch {
      // ignore
    }

    // 9. Build EvalRun
    const runId = shared.nanoid();
    const run: EvalRun = {
      id: runId,
      fixtureId,
      codeVersion,
      mode: "signal",
      startedAt,
      completedAt,
      stateTrace,
      metrics,
      findings: {
        deep: deepFindings.map((f) => ({
          stableFindingId: f.id,
          title: f.title,
          severity: f.severity,
          category: f.category,
          isBlocking: f.isBlocking,
          headSha: f.headSha,
          reviewer: "deep" as const,
        })),
        carmack: carmackFindings.map((f) => ({
          stableFindingId: f.id,
          title: f.title,
          severity: f.severity,
          category: f.category,
          isBlocking: f.isBlocking,
          headSha: f.headSha,
          reviewer: "carmack" as const,
        })),
      },
    };

    // 10. Write run result to runs/<runId>/run.json
    const runDir = resolve(RUNS_DIR, runId);
    mkdirSync(runDir, { recursive: true });

    const runPath = resolve(runDir, "run.json");
    writeFileSync(runPath, JSON.stringify(run, null, 2) + "\n");

    // 11. Print summary
    console.log(`\n--- Replay Summary ---`);
    console.log(`Run ID:          ${runId}`);
    console.log(`Fixture:         ${fixtureId}`);
    console.log(`Code version:    ${codeVersion.slice(0, 8)}`);
    console.log(`Signals:         ${metrics.totalSignals}`);
    console.log(`Fix cycles:      ${metrics.fixCycles}`);
    console.log(`Final state:     ${metrics.finalState}`);
    console.log(`Succeeded:       ${metrics.succeeded}`);
    console.log(`Convergence:     ${metrics.convergenceRate.toFixed(3)}`);
    console.log(
      `Findings:        ${metrics.totalFindings} (${metrics.blockingFindings} blocking)`,
    );
    console.log(`Unique causes:   ${metrics.uniqueRootCauses}`);
    console.log(`Cross-dup:       ${metrics.crossReviewerDuplicates}`);
    console.log(`Duration:        ${(totalDurationMs / 1000).toFixed(1)}s`);
    console.log(`\nWritten to: ${runPath}`);
  } finally {
    // Clean up seeded test data
    if (seeded) {
      try {
        await cleanupSeededState({ db, shared, state: seeded });
        console.log("Cleaned up test data");
      } catch (cleanupErr: unknown) {
        const msg =
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.warn("Cleanup warning:", msg);
      }
    }
    try {
      await (db.$client as any).end();
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error("Replay failed:", err);
  process.exit(1);
});
