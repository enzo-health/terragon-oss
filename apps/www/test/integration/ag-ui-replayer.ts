/**
 * AG-UI integration replayer — minimal harness that feeds a sequence of
 * AG-UI `BaseEvent`s through the product sidecar projection used beside the
 * assistant-ui runtime.
 *
 * This is the Phase 7 counterpart to the legacy daemon-event replayer
 * (`./replayer.ts`). The legacy harness exercises the full Next.js route
 * + DB pipeline; this one exercises the *frontend* half of the AG-UI
 * migration end-to-end, proving that an SSE-style BaseEvent stream updates
 * lifecycle, artifacts, runtime state, and quarantine state without becoming a
 * second transcript renderer.
 *
 * No DB, no Redis, no route — a pure in-memory `HttpAgent` double pumps
 * events into the hook. Suitable for deterministic CI assertions.
 */

import type { HttpAgent } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage } from "@terragon/shared";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getStableArtifactsForMessages } from "../../src/components/chat/thread-view-model/artifact-descriptors";
import { createEmptyThreadViewSnapshot } from "../../src/components/chat/thread-view-model/snapshot-adapter";
import type {
  ThreadViewLifecycle,
  ThreadViewQuarantineEntry,
  ThreadViewSnapshot,
} from "../../src/components/chat/thread-view-model/types";
import {
  useAgUiSidecarRouter,
  useThreadViewModel,
} from "../../src/components/chat/use-thread-view-model";
import { runReducerHarness } from "./streaming-harness/reducer-harness";

// ---------------------------------------------------------------------------
// Fake HttpAgent (mirrors the one in use-thread-view-model.test.tsx)
// ---------------------------------------------------------------------------

type AgUiSubscriber = (params: { event: BaseEvent }) => void;

export interface FakeAgent {
  subscribe: (subscriber: { onEvent?: AgUiSubscriber }) => {
    unsubscribe: () => void;
  };
  emit: (event: BaseEvent) => void;
  subscribers: AgUiSubscriber[];
}

export function createFakeAgent(): FakeAgent {
  const fake: FakeAgent = {
    subscribers: [],
    subscribe: (subscriber) => {
      const handler = subscriber.onEvent;
      if (handler) fake.subscribers.push(handler);
      return {
        unsubscribe: () => {
          if (handler) {
            const idx = fake.subscribers.indexOf(handler);
            if (idx >= 0) fake.subscribers.splice(idx, 1);
          }
        },
      };
    },
    emit: (event) => {
      for (const sub of [...fake.subscribers]) sub({ event });
    },
  };
  return fake;
}

export function asHttpAgent(fake: FakeAgent): HttpAgent {
  return fake as unknown as HttpAgent;
}

// ---------------------------------------------------------------------------
// Replay harness
// ---------------------------------------------------------------------------

export type ReplayAgUiOptions = {
  agentKind?: AIAgent;
  initialMessages?: UIMessage[];
};

export type ReplayAgUiResult = {
  /** Runtime transcript projection after all events are drained. */
  messages: UIMessage[];
  /** Final artifact descriptors projected by ThreadViewModel. */
  artifactDescriptors: ArtifactDescriptor[];
  /** Final lifecycle state projected by ThreadViewModel. */
  lifecycle: ThreadViewLifecycle;
  /** Explicit diagnostics for AG UI events the active renderer cannot handle yet. */
  quarantine: ThreadViewQuarantineEntry[];
  /** Snapshots of UIMessage[] after each event, for step-by-step assertions. */
  snapshots: UIMessage[][];
  /** Artifact descriptor references after each event, for stability assertions. */
  artifactSnapshots: ArtifactDescriptor[][];
};

/**
 * Mounts `useThreadViewModel` into a detached DOM, drives it with a fake
 * HttpAgent, emits each event in order, and captures the resulting
 * `UIMessage[]` projections.
 *
 * Callers are expected to run this inside a jsdom-enabled Vitest test
 * (`@vitest-environment jsdom`).
 */
export async function replayAgUi(
  events: BaseEvent[],
  options: ReplayAgUiOptions = {},
): Promise<ReplayAgUiResult> {
  const agentKind: AIAgent = options.agentKind ?? "claudeCode";
  const initialMessages: UIMessage[] = options.initialMessages ?? [];
  const initialSnapshot = createEmptyThreadViewSnapshot({
    agent: agentKind,
    initialMessages,
  });

  const fake = createFakeAgent();
  const agent = asHttpAgent(fake);

  const transcript = runReducerHarness(events, {
    agent: agentKind,
    initialMessages,
  });
  const artifactSnapshots = getArtifactSnapshots({
    snapshots: transcript.snapshots,
    snapshot: initialSnapshot,
  });
  let currentSidecarArtifacts: ArtifactDescriptor[] = [];
  let currentQuarantine: ThreadViewQuarantineEntry[] = [];
  let currentLifecycle: ThreadViewLifecycle = initialSnapshot.lifecycle;

  function onProjection(params: {
    artifactDescriptors: ArtifactDescriptor[];
    lifecycle: ThreadViewLifecycle;
    quarantine: ThreadViewQuarantineEntry[];
  }): void {
    const { artifactDescriptors, lifecycle, quarantine } = params;
    currentSidecarArtifacts = artifactDescriptors;
    currentLifecycle = lifecycle;
    currentQuarantine = quarantine;
  }

  // Headless mount
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(Harness, {
          agent,
          snapshot: initialSnapshot,
          onProjection,
        }),
      );
    });

    for (const ev of events) {
      await act(async () => {
        fake.emit(ev);
      });
    }

    return {
      messages: transcript.finalMessages,
      artifactDescriptors: [
        ...(artifactSnapshots.at(-1) ?? []),
        ...currentSidecarArtifacts,
      ],
      lifecycle: currentLifecycle,
      quarantine: currentQuarantine,
      snapshots: transcript.snapshots,
      artifactSnapshots,
    };
  } finally {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container.remove();
  }
}

// Internal harness component — invoked via createElement to avoid TSX in
// the replayer module (keeps this file usable from .ts tests too).
function Harness({
  agent,
  snapshot,
  onProjection,
}: {
  agent: HttpAgent | null;
  snapshot: ThreadViewSnapshot;
  onProjection: (params: {
    artifactDescriptors: ArtifactDescriptor[];
    lifecycle: ThreadViewLifecycle;
    quarantine: ThreadViewQuarantineEntry[];
  }) => void;
}): null {
  const viewModel = useThreadViewModel({ snapshot });
  useAgUiSidecarRouter({
    agent,
    dispatchThreadViewEvent: viewModel.dispatchThreadViewEvent,
  });
  onProjection({
    artifactDescriptors: viewModel.artifacts.descriptors,
    lifecycle: viewModel.lifecycle,
    quarantine: viewModel.quarantine,
  });
  return null;
}

function getArtifactSnapshots({
  snapshots,
  snapshot,
}: {
  snapshots: UIMessage[][];
  snapshot: ThreadViewSnapshot;
}): ArtifactDescriptor[][] {
  let artifacts = snapshot.artifacts;
  return snapshots.map((messages) => {
    artifacts = getStableArtifactsForMessages({
      previous: artifacts,
      messages,
      artifactThread: snapshot.artifactThread,
    });
    return artifacts.descriptors;
  });
}

// ---------------------------------------------------------------------------
// Event factories — convenience helpers for building BaseEvents by hand
// ---------------------------------------------------------------------------

export function textStart(messageId: string, timestamp = 0): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_START,
    timestamp,
    messageId,
    role: "assistant",
  } as BaseEvent;
}

export function textContent(
  messageId: string,
  delta: string,
  timestamp = 0,
): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    timestamp,
    messageId,
    delta,
  } as BaseEvent;
}

export function textEnd(messageId: string, timestamp = 0): BaseEvent {
  return {
    type: EventType.TEXT_MESSAGE_END,
    timestamp,
    messageId,
  } as BaseEvent;
}

export function toolCallStart(
  toolCallId: string,
  toolCallName: string,
  timestamp = 0,
  parentMessageId?: string,
): BaseEvent {
  return {
    type: EventType.TOOL_CALL_START,
    timestamp,
    toolCallId,
    toolCallName,
    ...(parentMessageId ? { parentMessageId } : {}),
  } as BaseEvent;
}

export function toolCallArgs(
  toolCallId: string,
  delta: string,
  timestamp = 0,
): BaseEvent {
  return {
    type: EventType.TOOL_CALL_ARGS,
    timestamp,
    toolCallId,
    delta,
  } as BaseEvent;
}

export function toolCallChunk(
  toolCallId: string,
  delta: string,
  timestamp = 0,
  eventId?: string,
): BaseEvent {
  return {
    type: EventType.TOOL_CALL_CHUNK,
    timestamp,
    toolCallId,
    delta,
    ...(eventId ? { eventId } : {}),
  } as BaseEvent;
}

export function toolCallEnd(toolCallId: string, timestamp = 0): BaseEvent {
  return {
    type: EventType.TOOL_CALL_END,
    timestamp,
    toolCallId,
  } as BaseEvent;
}

export function toolCallResult(
  toolCallId: string,
  content: string,
  isError = false,
  timestamp = 0,
): BaseEvent {
  return {
    type: EventType.TOOL_CALL_RESULT,
    timestamp,
    messageId: toolCallId,
    toolCallId,
    content,
    role: "tool" as const,
    ...(isError ? { isError: true } : {}),
  } as BaseEvent;
}

export function customRichPart(
  partType: string,
  messageId: string,
  part: Record<string, unknown>,
  partIndex = 0,
  timestamp = 0,
): BaseEvent {
  return {
    type: EventType.CUSTOM,
    timestamp,
    name: "terragon.data-part",
    value: {
      messageId,
      partIndex,
      name: `terragon.${partType}`,
      data: part,
    },
  } as BaseEvent;
}
