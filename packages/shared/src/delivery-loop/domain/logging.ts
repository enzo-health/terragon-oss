/** Structured logging context for delivery loop lifecycle events */
export type DeliveryLoopLogContext = {
  workflowId: string;
  threadId: string;
  correlationId: string;
  state: string;
  gate?: string;
  headSha?: string;
  signalId?: string;
  dispatchId?: string;
  pendingAction?: string;
};

export function buildLogContext(
  params: Partial<DeliveryLoopLogContext>,
): DeliveryLoopLogContext {
  return {
    workflowId: params.workflowId ?? "",
    threadId: params.threadId ?? "",
    correlationId: params.correlationId ?? "",
    state: params.state ?? "",
    gate: params.gate,
    headSha: params.headSha,
    signalId: params.signalId,
    dispatchId: params.dispatchId,
    pendingAction: params.pendingAction,
  };
}
