import type { DB } from "@terragon/shared/db";
import type { WorkflowId } from "@terragon/shared/delivery-loop/domain/workflow";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";

export type BabysitWorkPayload = {
  workflowId: string;
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
    const { getWorkflow } = await import(
      "@terragon/shared/delivery-loop/store/workflow-store"
    );
    const workflow = await getWorkflow({ db: params.db, workflowId });
    if (!workflow) {
      await completeWorkItem({
        db: params.db,
        workItemId: params.workItemId,
        claimToken: params.claimToken,
      });
      return;
    }

    // 2. If not in babysitting state, complete work item (stale)
    if (workflow.kind !== "babysitting") {
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

    const headSha = (workflow.headSha as string) ?? null;
    if (headSha) {
      const { evaluateBabysitCompletionForHead } = await import(
        "@terragon/shared/model/signal-inbox-core"
      );
      const babysitResult = await evaluateBabysitCompletionForHead({
        db: params.db,
        loopId: params.payload.workflowId,
        headSha,
      });

      if (babysitResult.allRequiredGatesPassed) {
        // Append babysit_passed signal for the coordinator tick
        const { appendSignalToInbox } = await import(
          "@terragon/shared/delivery-loop/store/signal-inbox-store"
        );
        await appendSignalToInbox({
          db: params.db,
          loopId: params.payload.workflowId,
          causeType: "babysit_recheck",
          payload: {
            source: "timer",
            event: { kind: "babysit_due" },
            babysitPassed: true,
            headSha,
          },
        });
      }
      // If gates did not pass, the periodic cron recheck handles retries.
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
