/**
 * AG-UI integration replayer — minimal harness that feeds a sequence of
 * AG-UI `BaseEvent`s through the same `useAgUiMessages` hook the chat
 * renders with, and returns the final `UIMessage[]` projection.
 *
 * This is the Phase 7 counterpart to the legacy daemon-event replayer
 * (`./replayer.ts`). The legacy harness exercises the full Next.js route
 * + DB pipeline; this one exercises the *frontend* half of the AG-UI
 * migration end-to-end, proving that an SSE-style BaseEvent stream
 * (TEXT_MESSAGE_START/CONTENT/END, TOOL_CALL_*, CUSTOM rich parts)
 * reduces to the same `UIMessage[]` shape the renderer consumes.
 *
 * No DB, no Redis, no route — a pure in-memory `HttpAgent` double pumps
 * events into the hook. Suitable for deterministic CI assertions.
 */

import type { HttpAgent } from "@ag-ui/client";
import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage } from "@terragon/shared";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAgUiMessages } from "../../src/components/chat/use-ag-ui-messages";

// ---------------------------------------------------------------------------
// Fake HttpAgent (mirrors the one in use-ag-ui-messages.test.tsx)
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
  /** Final UIMessage[] after all events are drained. */
  messages: UIMessage[];
  /** Snapshots of UIMessage[] after each event, for step-by-step assertions. */
  snapshots: UIMessage[][];
};

/**
 * Mounts `useAgUiMessages` into a detached DOM, drives it with a fake
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

  const fake = createFakeAgent();
  const agent = asHttpAgent(fake);

  const snapshots: UIMessage[][] = [];
  let current: UIMessage[] = [];

  function onMessages(msgs: UIMessage[]): void {
    current = msgs;
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
          agentKind,
          initialMessages,
          onMessages,
        }),
      );
    });

    // Seed snapshot captured after initial render
    snapshots.push(current);

    for (const ev of events) {
      await act(async () => {
        fake.emit(ev);
      });
      snapshots.push(current);
    }

    return { messages: current, snapshots };
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
  agentKind,
  initialMessages,
  onMessages,
}: {
  agent: HttpAgent | null;
  agentKind: AIAgent;
  initialMessages: UIMessage[];
  onMessages: (msgs: UIMessage[]) => void;
}): null {
  const messages = useAgUiMessages({ agent, agentKind, initialMessages });
  onMessages(messages);
  return null;
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
): BaseEvent {
  return {
    type: EventType.TOOL_CALL_START,
    timestamp,
    toolCallId,
    toolCallName,
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
    ...(isError ? { role: "tool" as const } : {}),
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
    name: `terragon.part.${partType}`,
    value: { messageId, partIndex, part },
  } as BaseEvent;
}
