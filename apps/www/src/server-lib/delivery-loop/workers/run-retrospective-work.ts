import type { DB } from "@terragon/shared/db";
import {
  completeWorkItem,
  failWorkItem,
} from "@terragon/shared/delivery-loop/store/work-queue-store";
import { computeAndStoreRetrospective } from "@terragon/shared/delivery-loop/store/retrospective-store";
import { stringifyError } from "./resolve-loop";

export type RetrospectiveWorkPayload = {
  workflowId: string;
};

export async function runRetrospectiveWork(params: {
  db: DB;
  workItemId: string;
  claimToken: string;
  payload: RetrospectiveWorkPayload;
}): Promise<void> {
  try {
    await computeAndStoreRetrospective({
      db: params.db,
      workflowId: params.payload.workflowId,
    });

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
      errorCode: "retrospective_failed",
      errorMessage: stringifyError(err),
      retryAt,
    });
  }
}
