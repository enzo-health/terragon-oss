import type { DB } from "@terragon/shared/db";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { getWorkflow } from "@terragon/shared/delivery-loop/store/workflow-store";
import { appendSignalToInbox } from "@terragon/shared/delivery-loop/store/signal-inbox-store";
import { evaluateBabysitCompletionForHead } from "@terragon/shared/model/signal-inbox-core";
import { eq, desc } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";

export type BabysitWorkPayload = {
  workflowId: string;
  loopId?: string;
};

/**
 * Execute a babysit work item: check whether all babysitting gates
 * pass for the current head SHA. If they do, append a babysit_passed
 * signal; otherwise append babysit_blocked.
 *
 * Actual babysit evaluation (CI gate status, review thread resolution,
 * deep/carmack review findings) is wired during Phase 7 migration,
 * referencing evaluateBabysitCompletionForHead from signal-inbox-core.
 */
export async function runBabysitWork(params: {
  db: DB;
  workItemId: string;
  claimToken: string;
  payload: BabysitWorkPayload;
}): Promise<void> {
  try {
    const workflowId = params.payload.workflowId as WorkflowId;

    // 1. Load workflow
    const workflow = await getWorkflow({ db: params.db, workflowId });
    if (!workflow) {
      console.warn(
        "[babysit-worker] workflow not found, completing stale work item",
        { workflowId, workItemId: params.workItemId },
      );
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
      });
      return;
    }

    // 2. If not in babysitting state, complete work item (stale)
    if (workflow.kind !== "babysitting") {
      console.warn(
        "[babysit-worker] workflow not in babysitting state, completing stale work item",
        {
          workflowId,
          currentState: workflow.kind,
          workItemId: params.workItemId,
        },
      );
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
      });
      return;
    }

    // 3. Run babysit recheck logic
    //
    // TODO(Phase 7 wiring): Wire to existing babysit evaluation:
    //
    // - evaluateBabysitCompletionForHead() from
    //   packages/shared/src/model/signal-inbox-core.ts
    //   Checks CI gate status, review thread resolution, deep/carmack
    //   review findings for the current head SHA.
    //   Returns: { requiredCiPassed, unresolvedReviewThreads,
    //              unresolvedDeepBlockers, unresolvedCarmackBlockers,
    //              allRequiredGatesPassed }
    //
    // - recheckBabysitCompletion() from
    //   apps/www/src/server-lib/delivery-loop/babysit-recheck.ts
    //   Polls GitHub CI and review threads directly (for missed webhooks),
    //   inserts synthetic signals into sdlcLoopSignalInbox.
    //
    // - appendSignalToInbox() from
    //   packages/shared/src/delivery-loop/store/signal-inbox-store.ts
    //   Appends a babysit_passed or babysit_blocked signal to the v2
    //   signal inbox so the coordinator tick picks it up.
    //
    // Flow:
    //   a) Extract headSha from workflow.stateJson
    //   b) Call evaluateBabysitCompletionForHead({ db, loopId, headSha })
    //   c) If allRequiredGatesPassed → append babysit_passed signal
    //   d) Else → schedule a recheck via recheckBabysitCompletion()
    //      or append babysit_blocked signal
    //

    const headSha = workflow.headSha ?? null;
    if (headSha) {
      // Resolve canonical loopId for gate evaluation
      let loopId = params.payload.loopId;
      if (!loopId) {
        const loop = await params.db.query.sdlcLoop.findFirst({
          where: eq(schema.sdlcLoop.threadId, workflow.threadId),
          orderBy: [desc(schema.sdlcLoop.createdAt)],
        });
        loopId = loop?.id ?? params.payload.workflowId;
      }

      const babysitResult = await evaluateBabysitCompletionForHead({
        db: params.db,
        loopId,
        headSha,
      });

      if (babysitResult.allRequiredGatesPassed) {
        // Append a babysit_recheck_passed signal so reduceBabysitSignal
        // transitions the babysitting workflow to babysit_passed.
        await appendSignalToInbox({
          db: params.db,
          loopId,
          causeType: "babysit_recheck_passed",
          payload: {
            source: "babysit",
            event: {
              kind: "babysit_gates_passed",
              headSha: headSha,
            },
          },
          canonicalCauseId: `babysit:${loopId}:${headSha}:gates_passed`,
        });
      } else {
        // Gates still failing — fail the work item with a retry so the
        // babysitting workflow gets rechecked. Without this, the workflow
        // would stall forever since cron only drains existing work items.
        const retryAt = new Date(Date.now() + 5 * 60_000); // 5min backoff
        await failWorkItem({
          db: params.db,
          workItemId: params.workItemId,
          claimToken: params.claimToken,
          errorCode: "babysit_gates_pending",
          errorMessage: "Babysit gates not yet passed, scheduling recheck",
          retryAt,
        });
        return;
      }
    }

    // 4. Complete work item
    await completeWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
    });
  } catch (err) {
    const retryAt = new Date(Date.now() + 60_000); // 1min backoff
    await failWorkItem({
      db: params.db,
      workItemId: params.workItemId,
      claimToken: params.claimToken,
      errorCode: "babysit_failed",
      errorMessage: err instanceof Error ? err.message : String(err),
      retryAt,
    });
  }
}
