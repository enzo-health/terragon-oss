/**
 * QA Validator - Main Orchestrator
 *
 * Coordinates fetching from all sources and running comparisons.
 */

import type {
  ValidatorConfig,
  ValidationResult,
  SourceSnapshot,
  DatabaseWorkflowState,
  DatabaseThreadState,
  UIWorkflowState,
  ContainerState,
} from "./types.js";
import {
  createDatabaseFetcher,
  DatabaseSourceFetcher,
} from "./sources/database.js";
import { createUIFetcher, UISourceFetcher } from "./sources/ui.js";
import {
  createContainerFetcher,
  ContainerSourceFetcher,
} from "./sources/container.js";
import { createComparator, ComparatorEngine } from "./comparator.js";

export class QAValidator {
  private dbFetcher?: DatabaseSourceFetcher;
  private uiFetcher?: UISourceFetcher;
  private containerFetcher?: ContainerSourceFetcher;
  private comparator: ComparatorEngine;
  private config: ValidatorConfig;

  constructor(config: ValidatorConfig) {
    this.config = config;
    this.comparator = createComparator();
  }

  async initialize(): Promise<void> {
    const initStart = Date.now();

    if (this.config.includeDatabase) {
      this.dbFetcher = createDatabaseFetcher();
    }

    if (this.config.includeUI) {
      this.uiFetcher = await createUIFetcher();
    }

    if (this.config.includeContainer) {
      this.containerFetcher = createContainerFetcher();
    }

    const initDuration = Date.now() - initStart;
    console.log(`QA Validator initialized in ${initDuration}ms`);
  }

  async validate(): Promise<ValidationResult> {
    const startTime = Date.now();
    const threadId = this.config.threadId;

    console.log(`\n🔍 Starting validation for thread ${threadId}...`);

    // Fetch all sources in parallel
    const fetchResults = await Promise.allSettled([
      this.fetchDatabase(threadId),
      this.fetchUI(threadId),
      this.fetchContainer(threadId),
    ]);

    const dbResult =
      fetchResults[0].status === "fulfilled"
        ? fetchResults[0].value
        : undefined;
    const uiResult =
      fetchResults[1].status === "fulfilled"
        ? fetchResults[1].value
        : undefined;
    const containerResult =
      fetchResults[2].status === "fulfilled"
        ? fetchResults[2].value
        : undefined;

    const dbWorkflow = dbResult?.workflow as
      | SourceSnapshot<DatabaseWorkflowState>
      | undefined;
    const dbThread = dbResult?.thread as
      | SourceSnapshot<DatabaseThreadState>
      | undefined;
    const uiDeliveryLoop = uiResult?.deliveryLoop as
      | SourceSnapshot<UIWorkflowState>
      | undefined;
    const container = containerResult as
      | SourceSnapshot<ContainerState>
      | undefined;

    // Check if using remote sandbox (not local Docker)
    const sandboxProvider = dbThread?.data.sandboxProvider;
    const isRemoteSandbox = sandboxProvider && sandboxProvider !== "docker";

    // Log results
    if (dbWorkflow) {
      const data = dbWorkflow.data as DatabaseWorkflowState;
      console.log(
        `✅ Database: state=${data.state}, version=${data.version} (${dbWorkflow.durationMs}ms)`,
      );
    } else if (fetchResults[0].status === "rejected") {
      console.log(`❌ Database fetch failed: ${fetchResults[0].reason}`);
    }

    if (dbThread) {
      const provider = dbThread.data.sandboxProvider || "unknown";
      console.log(
        `✅ Thread: status=${dbThread.data.status}, provider=${provider} (${dbThread.durationMs}ms)`,
      );
    }

    if (uiDeliveryLoop) {
      const data = uiDeliveryLoop.data as UIWorkflowState;
      console.log(
        `✅ UI: state=${data.state}, progress=${data.progressPercent}% (${uiDeliveryLoop.durationMs}ms)`,
      );
    } else if (uiResult?.detail) {
      console.log(
        `✅ UI: basic detail fetched (${uiResult.detail.durationMs}ms) - delivery loop status unavailable`,
      );
    } else if (fetchResults[1].status === "rejected") {
      console.log(`❌ UI fetch failed: ${fetchResults[1].reason}`);
    }

    if (container) {
      const data = container.data as ContainerState;
      if (isRemoteSandbox) {
        console.log(
          `⚠️  Container: Remote ${sandboxProvider} sandbox - local check skipped`,
        );
      } else if (data.error) {
        console.log(`⚠️  Container: ${data.error} (${container.durationMs}ms)`);
      } else {
        console.log(
          `✅ Container: status=${data.status}, daemon=${data.daemonRunning ? "running" : "stopped"} (${container.durationMs}ms)`,
        );
      }
    } else if (fetchResults[2].status === "rejected") {
      console.log(`❌ Container fetch failed: ${fetchResults[2].reason}`);
    }

    // Run comparison rules
    console.log(`\n⚖️  Running validation rules...`);

    // Skip container validation for remote sandboxes
    const containerForComparison = isRemoteSandbox ? undefined : container;

    const discrepancies = this.comparator.compare(threadId, {
      ui: uiDeliveryLoop,
      database: dbWorkflow
        ? {
            workflow: dbWorkflow as SourceSnapshot<DatabaseWorkflowState>,
            thread: dbThread as SourceSnapshot<DatabaseThreadState> | undefined,
          }
        : undefined,
      container: containerForComparison as
        | SourceSnapshot<ContainerState>
        | undefined,
    });

    // Add info discrepancy about remote sandbox
    if (isRemoteSandbox && container?.data.error) {
      discrepancies.push({
        id: `remote-sandbox-${Date.now()}`,
        timestamp: new Date(),
        type: "ui_stale_cache",
        severity: "info",
        threadId,
        sources: [
          {
            name: "database",
            fetchedAt: dbThread!.fetchedAt,
            durationMs: dbThread!.durationMs,
            data: { sandboxProvider },
          },
          {
            name: "container",
            fetchedAt: container.fetchedAt,
            durationMs: container.durationMs,
            data: { error: container.data.error },
          },
        ],
        description: `Remote ${sandboxProvider} sandbox - container validation skipped`,
        impact:
          "Cannot verify container health locally. Use E2B API or check remote dashboard.",
        recommendedFix:
          "Add E2B SDK integration to fetch remote sandbox status",
      });
    }

    // Categorize discrepancies
    const criticalCount = discrepancies.filter(
      (d) => d.severity === "critical",
    ).length;
    const warningCount = discrepancies.filter(
      (d) => d.severity === "warning",
    ).length;
    const infoCount = discrepancies.filter((d) => d.severity === "info").length;

    // Print discrepancies
    if (discrepancies.length > 0) {
      console.log(`\n⚠️  Found ${discrepancies.length} discrepancy(s):`);

      for (const d of discrepancies) {
        const icon =
          d.severity === "critical"
            ? "🔴"
            : d.severity === "warning"
              ? "🟡"
              : "🔵";
        console.log(`\n${icon} [${d.severity.toUpperCase()}] ${d.type}`);
        console.log(`   ${d.description}`);
        console.log(`   Impact: ${d.impact}`);
        if (d.recommendedFix) {
          console.log(`   Fix: ${d.recommendedFix}`);
        }
      }
    } else {
      console.log(`\n✅ All validation rules passed - no discrepancies found`);
    }

    const duration = Date.now() - startTime;

    const result: ValidationResult = {
      threadId,
      verifiedAt: new Date(),
      durationMs: duration,
      sources: {
        ui: uiDeliveryLoop as SourceSnapshot<UIWorkflowState> | undefined,
        database: dbWorkflow as
          | SourceSnapshot<DatabaseWorkflowState>
          | undefined,
        container: container as SourceSnapshot<ContainerState> | undefined,
      },
      discrepancies,
      isHealthy: criticalCount === 0,
      summary: {
        infoCount,
        warningCount,
        criticalCount,
        totalCount: discrepancies.length,
      },
    };

    this.printSummary(result, sandboxProvider, isRemoteSandbox);

    return result;
  }

  private async fetchDatabase(
    threadId: string,
  ): Promise<{ workflow?: SourceSnapshot; thread?: SourceSnapshot }> {
    if (!this.dbFetcher) {
      throw new Error("Database fetcher not initialized");
    }

    const [workflow, thread] = await Promise.all([
      this.dbFetcher.fetchWorkflowState(threadId),
      this.dbFetcher.fetchThreadState(threadId).catch(() => undefined),
    ]);

    return { workflow, thread };
  }

  private async fetchUI(
    threadId: string,
  ): Promise<{ detail?: SourceSnapshot; deliveryLoop?: SourceSnapshot }> {
    if (!this.uiFetcher) {
      throw new Error("UI fetcher not initialized");
    }

    return this.uiFetcher.fetchAll(threadId);
  }

  private async fetchContainer(threadId: string): Promise<SourceSnapshot> {
    if (!this.containerFetcher) {
      throw new Error("Container fetcher not initialized");
    }

    return this.containerFetcher.fetchForThread(threadId);
  }

  private printSummary(
    result: ValidationResult,
    sandboxProvider?: string,
    isRemoteSandbox?: boolean,
  ): void {
    console.log(
      `\n═══════════════════════════════════════════════════════════════`,
    );
    console.log(`VALIDATION SUMMARY`);
    console.log(
      `═══════════════════════════════════════════════════════════════`,
    );
    console.log(`Thread:     ${result.threadId}`);
    console.log(`Duration:   ${result.durationMs}ms`);
    console.log(
      `Status:     ${result.isHealthy ? "✅ HEALTHY" : "❌ UNHEALTHY"}`,
    );

    const sourcesList = [];
    if (result.sources.database) sourcesList.push("database");
    if (result.sources.ui) sourcesList.push("ui");
    if (result.sources.container) sourcesList.push("container");
    console.log(`Sources:    ${sourcesList.join(", ")}`);

    if (sandboxProvider) {
      const providerNote = isRemoteSandbox
        ? "(remote - validation limited)"
        : "(local)";
      console.log(`Sandbox:    ${sandboxProvider} ${providerNote}`);
    }

    console.log(
      `Issues:     ${result.summary.criticalCount} critical, ${result.summary.warningCount} warning, ${result.summary.infoCount} info`,
    );
    console.log(
      `═══════════════════════════════════════════════════════════════`,
    );
  }
}

export async function createValidator(
  config: ValidatorConfig,
): Promise<QAValidator> {
  const validator = new QAValidator(config);
  await validator.initialize();
  return validator;
}
