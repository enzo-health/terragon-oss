#!/usr/bin/env tsx
/**
 * Generate a formatted comparison report from a previously analyzed run.
 *
 * Usage:
 *   tsx scripts/report.ts <runDir>
 *
 * Expects <runDir>/analysis.json to exist (run analyze.ts first).
 * If analysis has comparisons, prints the comparison table.
 * Otherwise prints standalone metrics.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { EvalMetrics, MetricComparison } from "../src/types";
import { formatComparisonTable } from "../src/report/format-table";

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: tsx scripts/report.ts <runDir>");
    process.exit(1);
  }

  const runDir = resolve(args[0]);
  const analysisPath = resolve(runDir, "analysis.json");

  if (!existsSync(analysisPath)) {
    console.error(
      `analysis.json not found in ${runDir}. Run analyze.ts first.`,
    );
    process.exit(1);
  }

  const analysis = JSON.parse(readFileSync(analysisPath, "utf-8")) as {
    runId: string;
    fixtureId: string;
    codeVersion: string;
    metrics: EvalMetrics;
    comparisons?: MetricComparison[];
    report?: {
      fixtureId: string;
      baselineCodeVersion: string;
      currentCodeVersion: string;
      comparisons: MetricComparison[];
      summary: string;
    };
  };

  console.log(`\nEval Report: ${analysis.fixtureId}`);
  console.log(`Run: ${analysis.runId}`);
  console.log(`Code: ${analysis.codeVersion}`);

  if (analysis.comparisons && analysis.comparisons.length > 0) {
    if (analysis.report) {
      console.log(`Baseline: ${analysis.report.baselineCodeVersion}`);
    }
    console.log("\n" + formatComparisonTable(analysis.comparisons));

    if (analysis.report) {
      console.log(`\n${analysis.report.summary}`);
    }
  } else {
    console.log("\nMetrics (no baseline comparison available):");
    printMetrics(analysis.metrics);
  }

  console.log();
}

function printMetrics(metrics: EvalMetrics) {
  const labels: Record<string, string> = {
    totalSignals: "Total Signals",
    fixCycles: "Fix Cycles",
    maxFixCyclesBeforeBlock: "Max Fix Before Block",
    totalDurationMs: "Total Duration (s)",
    convergenceRate: "Convergence Rate",
    totalFindings: "Total Findings",
    blockingFindings: "Blocking Findings",
    uniqueRootCauses: "Unique Root Causes",
    signalToNoiseRatio: "Signal/Noise Ratio",
    crossReviewerDuplicates: "Cross-Reviewer Dupes",
    finalState: "Final State",
    succeeded: "Succeeded",
  };

  const maxLabel = Math.max(...Object.values(labels).map((l) => l.length));

  for (const [key, label] of Object.entries(labels)) {
    const raw = metrics[key as keyof EvalMetrics];
    let display: string;
    if (key === "totalDurationMs") {
      display = `${Math.round((raw as number) / 1000)}s`;
    } else if (typeof raw === "number" && !Number.isInteger(raw)) {
      display = String(Math.round(raw * 100) / 100);
    } else {
      display = String(raw);
    }
    console.log(`  ${label.padEnd(maxLabel + 2)}${display}`);
  }
}

main();
