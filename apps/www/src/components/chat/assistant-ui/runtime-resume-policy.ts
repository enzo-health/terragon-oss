export type RuntimeHistoryMode = "active-resume" | "idle-finalized";

export type RuntimeReplayCursorAction = "apply-history-last-seq" | "clear";

export type RuntimeResumePolicy = {
  historyLoadKey: string;
  historyMode: RuntimeHistoryMode;
  replayCursorAction: RuntimeReplayCursorAction;
};

export function resolveRuntimeResumePolicy({
  isAgentWorking,
  serverRunActive,
  threadChatId,
  retryNonce = 0,
}: {
  isAgentWorking: boolean;
  /**
   * Server-authoritative run liveness from the history projection. When
   * `undefined` (flag off, or server did not report), the policy uses
   * `isAgentWorking` only — identical to legacy behavior. When defined, it is
   * the PRIMARY signal: the stream opens whenever the server reports an active
   * run OR the client thinks the agent is working. `isAgentWorking` is then a
   * secondary close hint (it can still open optimistically, e.g. the booting
   * flip, but no longer holds the stream closed against a live server run).
   */
  serverRunActive?: boolean;
  threadChatId?: string;
  retryNonce?: number;
}): RuntimeResumePolicy {
  const isLive =
    serverRunActive === undefined
      ? isAgentWorking
      : serverRunActive || isAgentWorking;
  const historyMode = isLive ? "active-resume" : "idle-finalized";
  const keyMode = isLive ? "active" : "idle";
  const baseHistoryLoadKey = `${threadChatId ?? "unknown"}:${keyMode}`;

  return {
    historyLoadKey:
      retryNonce > 0
        ? `${baseHistoryLoadKey}:retry-${retryNonce}`
        : baseHistoryLoadKey,
    historyMode,
    replayCursorAction: isLive ? "apply-history-last-seq" : "clear",
  };
}
