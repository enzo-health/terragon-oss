export type RuntimeHistoryMode = "active-resume" | "idle-finalized";

export type RuntimeReplayCursorAction = "apply-history-last-seq" | "clear";

export type RuntimeResumePolicy = {
  historyLoadKey: string;
  historyMode: RuntimeHistoryMode;
  replayCursorAction: RuntimeReplayCursorAction;
};

export function resolveRuntimeResumePolicy({
  isAgentWorking,
  threadChatId,
  retryNonce = 0,
}: {
  isAgentWorking: boolean;
  threadChatId?: string;
  retryNonce?: number;
}): RuntimeResumePolicy {
  const historyMode = isAgentWorking ? "active-resume" : "idle-finalized";
  const keyMode = isAgentWorking ? "active" : "idle";
  const baseHistoryLoadKey = `${threadChatId ?? "unknown"}:${keyMode}`;

  return {
    historyLoadKey:
      retryNonce > 0
        ? `${baseHistoryLoadKey}:retry-${retryNonce}`
        : baseHistoryLoadKey,
    historyMode,
    replayCursorAction: isAgentWorking ? "apply-history-last-seq" : "clear",
  };
}
