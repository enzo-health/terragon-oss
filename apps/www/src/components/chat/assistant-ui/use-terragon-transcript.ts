"use client";

import { useAuiState } from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage, UIPart, UIUserMessage } from "@terragon/shared";
import { useMemo } from "react";
import { createRuntimeTranscriptProjector } from "./runtime-transcript-adapter";
import { createTerragonTranscriptModelBuilder } from "./terragon-transcript-model";

export type TerragonTranscript = {
  messages: UIMessage[];
  latestAgentMessageIndex: number;
  hasRenderableAgentParts: boolean;
  hasPendingToolCall: boolean;
  planOccurrencesRaw: Map<UIPart, number>;
  isRuntimeHydrating: boolean;
};

export type UseTerragonTranscriptInput = {
  chatAgent: AIAgent;
  optimisticUserMessages: UIUserMessage[];
};

export function useTerragonTranscript({
  chatAgent,
  optimisticUserMessages,
}: UseTerragonTranscriptInput): TerragonTranscript {
  const runtimeMessages = useAuiState((state) => state.thread.messages);
  const runtimeIsLoading = useAuiState((state) => state.thread.isLoading);
  const runtimeTranscriptProjector = useMemo(
    () => createRuntimeTranscriptProjector(),
    [],
  );
  const projectedTranscript = useMemo(
    () =>
      runtimeTranscriptProjector({
        runtimeMessages,
        agent: chatAgent,
      }),
    [chatAgent, runtimeMessages, runtimeTranscriptProjector],
  );
  const transcriptModelBuilder = useMemo(
    () => createTerragonTranscriptModelBuilder(),
    [],
  );
  const transcriptModel = useMemo(
    () =>
      transcriptModelBuilder({
        runtimeMessages: projectedTranscript.messages,
        optimisticUserMessages,
      }),
    [
      optimisticUserMessages,
      projectedTranscript.messages,
      transcriptModelBuilder,
    ],
  );

  return {
    ...transcriptModel,
    isRuntimeHydrating:
      runtimeIsLoading &&
      runtimeMessages.length === 0 &&
      transcriptModel.messages.length === 0,
  };
}
