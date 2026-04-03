/**
 * Comparator Engine
 *
 * Compares data from multiple sources and generates discrepancy reports.
 * This is the heart of the QA validation system.
 */

import type {
  SourceSnapshot,
  Discrepancy,
  DiscrepancySeverity,
  DiscrepancyType,
  DatabaseWorkflowState,
  DatabaseThreadState,
  UIWorkflowState,
  ContainerState,
  NormalizedState,
} from "./types.js";

export interface ComparisonRule {
  name: string;
  description: string;
  check: (sources: SourceCollection) => Discrepancy | null;
}

interface SourceCollection {
  ui?: SourceSnapshot<UIWorkflowState>;
  database?: {
    workflow?: SourceSnapshot<DatabaseWorkflowState>;
    thread?: SourceSnapshot<DatabaseThreadState>;
  };
  container?: SourceSnapshot<ContainerState>;
}

export class ComparatorEngine {
  private rules: ComparisonRule[];

  constructor() {
    this.rules = this.buildRules();
  }

  compare(threadId: string, sources: SourceCollection): Discrepancy[] {
    const discrepancies: Discrepancy[] = [];

    for (const rule of this.rules) {
      try {
        const discrepancy = rule.check(sources);
        if (discrepancy) {
          discrepancies.push(discrepancy);
        }
      } catch (error) {
        // Log error but don't fail validation - other rules may still work
        console.error(`Rule ${rule.name} failed:`, error);
      }
    }

    return discrepancies;
  }

  private buildRules(): ComparisonRule[] {
    return [
      this.stateMismatchRule(),
      this.versionMismatchRule(),
      this.containerActivityMismatchRule(),
      this.prLinkageMismatchRule(),
      this.gitShaMismatchRule(),
      this.gateStatusMismatchRule(),
      this.staleDataRule(),
      this.containerCrashRule(),
      this.threadStatusMismatchRule(),
    ];
  }

  /**
   * Rule: UI state should match database workflow state
   */
  private stateMismatchRule(): ComparisonRule {
    return {
      name: "state-mismatch",
      description: "UI state must match database workflow state",
      check: (sources) => {
        if (!sources.ui?.data || !sources.database?.workflow?.data) {
          return null; // Can't compare if either source is missing
        }

        const uiState = this.normalizeUIState(sources.ui.data);
        const dbState = this.normalizeDBState(sources.database.workflow.data);

        if (uiState.state === dbState.state) {
          return null;
        }

        return this.createDiscrepancy({
          type: "database_ui_mismatch",
          severity: "critical",
          threadId: sources.database.workflow.data.threadId,
          sources: [
            { snapshot: sources.ui, field: "state", value: uiState.state },
            {
              snapshot: sources.database.workflow,
              field: "state",
              value: dbState.state,
            },
          ],
          description: `UI shows state '${uiState.state}' but database shows '${dbState.state}'`,
          impact:
            "User sees incorrect task progress, may take wrong actions or miss critical state changes",
          recommendedFix:
            "Check React Query cache invalidation on workflow state transitions. Ensure PartySocket messages trigger cache refresh.",
        });
      },
    };
  }

  /**
   * Rule: Database version should match event journal max version
   */
  private versionMismatchRule(): ComparisonRule {
    return {
      name: "version-mismatch",
      description: "Workflow version should be consistent across sources",
      check: (sources) => {
        if (!sources.database?.workflow?.data) {
          return null;
        }

        const workflowVersion = sources.database.workflow.data.version;

        // If we have journal data, compare versions
        // (Would need to add journal fetch to sources)

        // Check if UI version matches (if available)
        if (sources.ui?.data) {
          // UI doesn't expose version directly, but we can infer from state
          // This is a weaker check
        }

        // For now, just ensure version is reasonable
        if (workflowVersion < 1) {
          return this.createDiscrepancy({
            type: "workflow_version_skew",
            severity: "warning",
            threadId: sources.database.workflow.data.threadId,
            sources: [
              {
                snapshot: sources.database.workflow,
                field: "version",
                value: workflowVersion,
              },
            ],
            description: `Workflow version ${workflowVersion} is suspiciously low`,
            impact:
              "May indicate workflow was reset or event journal is incomplete",
            recommendedFix: "Verify event journal continuity for this workflow",
          });
        }

        return null;
      },
    };
  }

  /**
   * Rule: Container should be running if workflow has active run
   */
  private containerActivityMismatchRule(): ComparisonRule {
    return {
      name: "container-activity-mismatch",
      description: "Container status must match workflow activity state",
      check: (sources) => {
        if (!sources.database?.workflow?.data || !sources.container?.data) {
          return null;
        }

        const dbWorkflow = sources.database.workflow.data;
        const containerSnapshot = sources.container;
        const container = containerSnapshot.data;

        // Guard against null container data
        if (!container) {
          return null;
        }

        const hasActiveRun = !!dbWorkflow.activeRunId;
        const containerRunning =
          container.status === "running" && container.daemonRunning;
        const isBootstrapWindow =
          dbWorkflow.state === "planning" && container.status === "running";

        // Check if container fetch failed (e.g., not found vs actual daemon issue)
        const containerError = containerSnapshot.error;

        if (hasActiveRun && !containerRunning) {
          // Distinguish between container not found (heuristic failed) vs daemon not running
          const severity: DiscrepancySeverity = containerError
            ? "warning" // Container not found - might be discoverability issue
            : isBootstrapWindow
              ? "warning" // Container is up, daemon may still be starting
              : "critical"; // Container found but daemon not running - actual problem

          return this.createDiscrepancy({
            type: "container_db_mismatch",
            severity,
            threadId: dbWorkflow.threadId,
            sources: [
              {
                snapshot: sources.database.workflow,
                field: "activeRunId",
                value: dbWorkflow.activeRunId,
              },
              {
                snapshot: sources.container,
                field: "daemonRunning",
                value: container.daemonRunning,
              },
            ],
            description: containerError
              ? `Database shows active run '${dbWorkflow.activeRunId}' but container could not be found (${containerError}). Container may be running but not discoverable via label/name heuristics.`
              : isBootstrapWindow
                ? `Database shows active run '${dbWorkflow.activeRunId}' while workflow is '${dbWorkflow.state}', but daemon has not started yet.`
                : `Database shows active run '${dbWorkflow.activeRunId}' but container daemon is not running (status: ${container.status})`,
            impact: containerError
              ? "Cannot verify container health - it may be running fine but discovery failed."
              : isBootstrapWindow
                ? "Likely bootstrap delay. If this persists, task startup may be stuck."
                : "Task appears to be working but is actually stalled. User may wait indefinitely for completion.",
            recommendedFix: containerError
              ? "Check container labels (threadId) or naming conventions for discovery."
              : isBootstrapWindow
                ? "Wait briefly and re-check. If daemon stays stopped, inspect startup logs and bootstrap timing."
                : "Check daemon crash detection and auto-restart logic. Container may need manual intervention.",
          });
        }

        return null;
      },
    };
  }

  /**
   * Rule: PR linkage should be consistent
   */
  private prLinkageMismatchRule(): ComparisonRule {
    return {
      name: "pr-linkage-mismatch",
      description: "PR linkage should be consistent across sources",
      check: (sources) => {
        if (!sources.database?.thread?.data || !sources.ui?.data) {
          return null;
        }

        const dbThread = sources.database.thread.data;
        const uiData = sources.ui.data;

        const dbHasPR = !!dbThread.githubPrNumber;
        const uiHasPR = !!uiData.links.pullRequestUrl;

        if (dbHasPR !== uiHasPR) {
          return this.createDiscrepancy({
            type: "pr_state_mismatch",
            severity: "warning",
            threadId: dbThread.id,
            sources: [
              {
                snapshot: sources.database.thread,
                field: "githubPrNumber",
                value: dbThread.githubPrNumber,
              },
              {
                snapshot: sources.ui,
                field: "pullRequestUrl",
                value: uiData.links.pullRequestUrl,
              },
            ],
            description: `Database ${dbHasPR ? "has" : "missing"} PR #${dbThread.githubPrNumber} but UI ${uiHasPR ? "has" : "missing"} PR link`,
            impact: "User may not see PR link or may see broken link",
            recommendedFix:
              "Check PR creation event handling and UI link generation",
          });
        }

        return null;
      },
    };
  }

  /**
   * Rule: Git SHA should match between DB and container
   */
  private gitShaMismatchRule(): ComparisonRule {
    return {
      name: "git-sha-mismatch",
      description: "Git HEAD SHA should match between database and container",
      check: (sources) => {
        if (
          !sources.database?.workflow?.data ||
          !sources.container?.data?.gitStatus
        ) {
          return null;
        }

        const dbSha = sources.database.workflow.data.headSha;
        const containerSha = sources.container.data.gitStatus?.headSha;
        const state = sources.database.workflow.data.state;
        const hasActiveRun = !!sources.database.workflow.data.activeRunId;

        // Once we are waiting on external PR lifecycle, the sandbox can safely
        // diverge (follow-up commits/rebases) without indicating state machine
        // drift. Keep SHA parity checks focused on active execution/gating.
        if (
          hasActiveRun ||
          state === "awaiting_pr_lifecycle" ||
          state === "done" ||
          state === "stopped" ||
          state === "terminated"
        ) {
          return null;
        }

        if (!dbSha || !containerSha) {
          return null; // Can't compare if either is missing
        }

        if (dbSha !== containerSha) {
          return this.createDiscrepancy({
            type: "container_db_mismatch",
            severity: "warning",
            threadId: sources.database.workflow.data.threadId,
            sources: [
              {
                snapshot: sources.database.workflow,
                field: "headSha",
                value: dbSha,
              },
              {
                snapshot: sources.container,
                field: "gitStatus.headSha",
                value: containerSha,
              },
            ],
            description: `Database shows HEAD SHA '${dbSha.slice(0, 8)}' but container shows '${containerSha.slice(0, 8)}'`,
            impact:
              "Container and database have divergent git state. May indicate sync issue or pending commits.",
            recommendedFix: "Check git push completion and SHA update timing",
          });
        }

        return null;
      },
    };
  }

  /**
   * Rule: Gate status should match checks
   */
  private gateStatusMismatchRule(): ComparisonRule {
    return {
      name: "gate-status-mismatch",
      description: "Active gate should match UI check status",
      check: (sources) => {
        if (!sources.database?.workflow?.data || !sources.ui?.data) {
          return null;
        }

        const dbGate = sources.database.workflow.data.activeGate;
        const uiChecks = sources.ui.data.checks;

        if (!dbGate) {
          return null; // No active gate
        }

        // Map gate to check key
        const gateToCheck: Record<string, string> = {
          ci: "ci",
          review_threads: "review_threads",
          deep_review: "deep_review",
          architecture_carmack: "architecture_carmack",
          video: "video",
        };

        const expectedCheckKey = gateToCheck[dbGate];
        if (!expectedCheckKey) {
          return null; // Unknown gate type
        }

        const matchingCheck = uiChecks.find((c) => c.key === expectedCheckKey);

        if (!matchingCheck) {
          return this.createDiscrepancy({
            type: "gate_status_mismatch",
            severity: "warning",
            threadId: sources.database.workflow.data.threadId,
            sources: [
              {
                snapshot: sources.database.workflow,
                field: "activeGate",
                value: dbGate,
              },
              {
                snapshot: sources.ui,
                field: "checks",
                value: uiChecks.map((c) => c.key).join(", "),
              },
            ],
            description: `Database shows active gate '${dbGate}' but UI checks don't include matching check`,
            impact:
              "User may not see correct gate status or gate may be stalled",
            recommendedFix: "Check gate evaluation status publishing to UI",
          });
        }

        return null;
      },
    };
  }

  /**
   * Rule: Data should not be stale
   */
  private staleDataRule(): ComparisonRule {
    return {
      name: "stale-data",
      description: "Data should be recent (not stale)",
      check: (sources) => {
        const now = Date.now();
        const maxAgeMs = 60000; // 1 minute

        const snapshots: Array<{ name: string; snapshot?: SourceSnapshot }> = [
          { name: "UI", snapshot: sources.ui },
          { name: "DB workflow", snapshot: sources.database?.workflow },
          { name: "DB thread", snapshot: sources.database?.thread },
          { name: "Container", snapshot: sources.container },
        ];

        for (const { name, snapshot } of snapshots) {
          if (!snapshot) continue;

          const ageMs = now - snapshot.fetchedAt.getTime();

          if (ageMs > maxAgeMs) {
            return this.createDiscrepancy({
              type: "ui_stale_cache",
              severity: "info",
              threadId: "unknown", // Would need to extract from snapshot
              sources: [
                {
                  snapshot,
                  field: "fetchedAt",
                  value: snapshot.fetchedAt.toISOString(),
                },
              ],
              description: `${name} data is ${Math.round(ageMs / 1000)}s old (max: ${maxAgeMs / 1000}s)`,
              impact: "Validation based on potentially outdated information",
              recommendedFix:
                "Increase fetch frequency or check for slow queries",
            });
          }
        }

        return null;
      },
    };
  }

  /**
   * Rule: Container should not be crashed/stopped unexpectedly
   */
  private containerCrashRule(): ComparisonRule {
    return {
      name: "container-crash",
      description: "Container should not be in crashed/stopped state",
      check: (sources) => {
        if (!sources.container?.data || !sources.database?.workflow?.data) {
          return null;
        }

        const container = sources.container.data;
        const workflow = sources.database.workflow.data;

        // Terminal workflow states that don't need container
        const terminalStates = ["done", "stopped", "terminated"];
        const isTerminal = terminalStates.includes(workflow.state);

        if (container.status === "exited" && !isTerminal) {
          return this.createDiscrepancy({
            type: "container_db_mismatch",
            severity: "critical",
            threadId: workflow.threadId,
            sources: [
              {
                snapshot: sources.container,
                field: "status",
                value: container.status,
              },
              {
                snapshot: sources.database.workflow,
                field: "state",
                value: workflow.state,
              },
            ],
            description: `Container has exited but workflow is in '${workflow.state}' state (expected terminal: ${isTerminal})`,
            impact:
              "Task is unable to progress. User sees working state but no actual work happening.",
            recommendedFix:
              "Check container exit reason (OOM, error, manual stop). May need sandbox restart.",
          });
        }

        return null;
      },
    };
  }

  /**
   * Rule: Thread status should match workflow state
   */
  private threadStatusMismatchRule(): ComparisonRule {
    return {
      name: "thread-status-mismatch",
      description: "Thread status should be consistent with workflow state",
      check: (sources) => {
        if (
          !sources.database?.thread?.data ||
          !sources.database?.workflow?.data
        ) {
          return null;
        }

        const thread = sources.database.thread.data;
        const workflow = sources.database.workflow.data;

        // Map workflow states to expected thread statuses
        const expectedThreadStatuses = this.inferThreadStatusesFromWorkflow(
          workflow.state,
        );

        if (
          expectedThreadStatuses &&
          !expectedThreadStatuses.includes(thread.status)
        ) {
          return this.createDiscrepancy({
            type: "database_ui_mismatch",
            severity: "warning",
            threadId: thread.id,
            sources: [
              {
                snapshot: sources.database.thread,
                field: "status",
                value: thread.status,
              },
              {
                snapshot: sources.database.workflow,
                field: "state",
                value: workflow.state,
              },
            ],
            description: `Thread status is '${thread.status}' but workflow state '${workflow.state}' suggests one of [${expectedThreadStatuses.join(", ")}]`,
            impact:
              "UI thread list may show incorrect status vs actual workflow progress",
            recommendedFix:
              "Check thread status update triggers on workflow state transitions",
          });
        }

        return null;
      },
    };
  }

  // Helper methods

  private createDiscrepancy(params: {
    type: DiscrepancyType;
    severity: DiscrepancySeverity;
    threadId: string;
    sources: Array<{ snapshot: SourceSnapshot; field: string; value: unknown }>;
    description: string;
    impact: string;
    recommendedFix?: string;
  }): Discrepancy {
    return {
      id: `${params.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date(),
      type: params.type,
      severity: params.severity,
      threadId: params.threadId,
      sources: params.sources.map((s) => ({
        name: s.snapshot.name,
        fetchedAt: s.snapshot.fetchedAt,
        durationMs: s.snapshot.durationMs,
        data: { [s.field]: s.value },
      })),
      field: params.sources[0]?.field,
      description: params.description,
      impact: params.impact,
      recommendedFix: params.recommendedFix,
    };
  }

  private normalizeUIState(uiData: UIWorkflowState): NormalizedState {
    return {
      threadId: "", // Would need to extract from context
      workflowId: uiData.loopId,
      state: uiData.state,
      stateTimestamp: uiData.updatedAtIso,
      version: 0, // Not exposed in UI
      isActive: ![
        "done",
        "stopped",
        "terminated",
        "awaiting_operator_action",
      ].includes(uiData.state),
      hasContainer: true, // Assumed
      hasPR: !!uiData.links.pullRequestUrl,
      prNumber: undefined, // Would need to extract from URL
      headSha: uiData.artifacts.implementationArtifact?.headSha || undefined,
      activeGate: uiData.phases.find((p) => p.status === "blocked")?.key,
      blockers: uiData.needsAttention.topBlockers.map((b) => b.title),
    };
  }

  private normalizeDBState(dbData: DatabaseWorkflowState): NormalizedState {
    return {
      threadId: dbData.threadId,
      workflowId: dbData.workflowId,
      state: dbData.state,
      stateTimestamp: dbData.updatedAt,
      version: dbData.version,
      isActive: !!dbData.activeRunId,
      hasContainer: true, // Would need to check sandbox table
      hasPR: false, // Would need thread data
      headSha: dbData.headSha || undefined,
      activeGate: dbData.activeGate || undefined,
      blockers: dbData.blockedReason ? [dbData.blockedReason] : [],
    };
  }

  private inferThreadStatusesFromWorkflow(
    workflowState: string,
  ): string[] | null {
    const mapping: Record<string, string[]> = {
      planning: ["queued", "working"],
      implementing: ["working"],
      review_gate: ["working"],
      ci_gate: ["working"],
      ui_testing: ["working"],
      done: ["complete"],
      stopped: ["stopped"],
      terminated: ["complete"],
      blocked: ["working"],
    };
    return mapping[workflowState] || null;
  }
}

export function createComparator(): ComparatorEngine {
  return new ComparatorEngine();
}
