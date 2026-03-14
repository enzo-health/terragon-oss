#!/usr/bin/env tsx
/**
 * Compute EvalMetrics from a run and optionally compare against a baseline.
 *
 * Usage:
 *   tsx scripts/analyze.ts <runDir> [--baseline <baselineFile>]
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import type {
  EvalRun,
  EvalMetrics,
  EvalReport,
  MetricComparison,
} from "../src/types";
import { computeMetrics } from "../src/analyze/compute-metrics";
import { compareMetrics } from "../src/analyze/compare";
import { formatComparisonTable } from "../src/report/format-table";

function parseArgs(): { runDir: string; baselineFile: string | null } {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(
      "Usage: tsx scripts/analyze.ts <runDir> [--baseline <baselineFile>]",
    );
    process.exit(1);
  }

  const runDir = resolve(args[0]!);
  let baselineFile: string | null = null;

  const bIdx = args.indexOf("--baseline");
  if (bIdx !== -1 && args[bIdx + 1]) {
    baselineFile = resolve(args[bIdx + 1]!);
  }

  return { runDir, baselineFile };
}

function loadJson<T>(path: string): T {
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function main() {
  const { runDir, baselineFile } = parseArgs();

  // Load run
  const runPath = resolve(runDir, "run.json");
  const run = loadJson<EvalRun>(runPath);

  // Compute metrics from state trace
  const metrics = computeMetrics(run);
  console.log(
    `\nComputed metrics for run ${run.id} (fixture: ${run.fixtureId})`,
  );

  // Build analysis output
  const analysis: {
    runId: string;
    fixtureId: string;
    codeVersion: string;
    metrics: EvalMetrics;
    comparisons?: MetricComparison[];
    report?: EvalReport;
  } = {
    runId: run.id,
    fixtureId: run.fixtureId,
    codeVersion: run.codeVersion,
    metrics,
  };

  // Compare against baseline if provided
  if (baselineFile) {
    // Baseline can be either an EvalMetrics file or an analysis.json with a metrics key
    const baselineRaw = loadJson<Record<string, unknown>>(baselineFile);
    let baselineMetrics: EvalMetrics;

    if ("metrics" in baselineRaw && typeof baselineRaw.metrics === "object") {
      baselineMetrics = baselineRaw.metrics as EvalMetrics;
    } else if (
      "baselineMetrics" in baselineRaw &&
      typeof baselineRaw.baselineMetrics === "object"
    ) {
      baselineMetrics = baselineRaw.baselineMetrics as EvalMetrics;
    } else if ("fixCycles" in baselineRaw) {
      baselineMetrics = baselineRaw as unknown as EvalMetrics;
    } else {
      console.error(
        "Baseline file must contain EvalMetrics or an object with a metrics key",
      );
      process.exit(1);
    }

    const comparisons = compareMetrics(baselineMetrics, metrics);
    analysis.comparisons = comparisons;

    const baselineVersion =
      "codeVersion" in baselineRaw
        ? String(baselineRaw.codeVersion)
        : "unknown";

    analysis.report = {
      fixtureId: run.fixtureId,
      baselineCodeVersion: baselineVersion,
      currentCodeVersion: run.codeVersion,
      comparisons,
      summary: summarize(comparisons),
    };

    // Print comparison table
    console.log("\n" + formatComparisonTable(comparisons));
    console.log(`\n${analysis.report.summary}\n`);
  } else {
    // No baseline — print standalone metrics
    console.log("\nMetrics (no baseline for comparison):");
    const entries = Object.entries(metrics) as [string, unknown][];
    for (const [key, value] of entries) {
      if (key === "totalDurationMs") {
        console.log(`  ${key}: ${Math.round((value as number) / 1000)}s`);
      } else {
        console.log(`  ${key}: ${value}`);
      }
    }
    console.log();
  }

  // Write analysis
  const outPath = resolve(runDir, "analysis.json");
  writeFileSync(outPath, JSON.stringify(analysis, null, 2) + "\n");
  console.log(`Analysis written to ${outPath}`);
}

function summarize(comparisons: MetricComparison[]): string {
  const improved = comparisons.filter((c) => c.improved === true).length;
  const regressed = comparisons.filter((c) => c.improved === false).length;
  const unchanged = comparisons.filter((c) => c.improved === null).length;

  const parts: string[] = [];
  if (improved > 0) parts.push(`${improved} improved`);
  if (regressed > 0) parts.push(`${regressed} regressed`);
  if (unchanged > 0) parts.push(`${unchanged} unchanged`);

  const verdict = regressed === 0 ? "PASS" : "FAIL";
  return `${verdict}: ${parts.join(", ")}`;
}

main();
