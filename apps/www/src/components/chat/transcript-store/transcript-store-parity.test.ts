import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventType, type BaseEvent, type Message } from "@ag-ui/core";
import { mapCanonicalEventToAgui } from "@terragon/agent/ag-ui-mapper";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import { buildCanonicalEventsForBatch } from "@terragon/daemon/daemon-canonical-events";
import type {
  ClaudeMessage,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import { describe, expect, it } from "vitest";
import {
  getDurableAgUiHistoryItemsFromEvents,
  type DurableAgUiHistoryItem,
} from "@/server-lib/ag-ui/durable-history-builder";
import { foldAgUiEnvelopes } from "./apply-ag-ui-event";
import {
  projectTranscriptState,
  type NormalizedTranscript,
} from "./project-transcript";
import type { TranscriptEnvelope } from "./transcript-item";

const RECORDINGS_DIR = join(
  __dirname,
  "../../../../test/integration/recordings",
);
const RUN_ID = "run-parity";

function readRecordingBodies(file: string): DaemonEventAPIBody[] {
  const raw = readFileSync(join(RECORDINGS_DIR, file), "utf8");
  const bodies: DaemonEventAPIBody[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    const parsed = JSON.parse(trimmed);
    bodies.push((parsed.body ?? parsed) as DaemonEventAPIBody);
  }
  return bodies;
}

function inferAgent(file: string): "claudeCode" | "codex" {
  return file.includes("codex") ? "codex" : "claudeCode";
}

function buildAgUiStream(
  bodies: DaemonEventAPIBody[],
  agent: "claudeCode" | "codex",
): BaseEvent[] {
  const canonical: CanonicalEvent[] = [];
  let nextCanonicalSeq = 0;
  let runStartedEmitted = false;
  let terminalEmitted = false;
  for (const body of bodies) {
    const messages = (body.messages ?? []) as ClaudeMessage[];
    const result = buildCanonicalEventsForBatch({
      runId: RUN_ID,
      agent,
      model: null,
      transportMode: "acp",
      protocolVersion: 2,
      nextCanonicalSeq,
      canonicalRunStartedEmitted: runStartedEmitted,
      canonicalTerminalEmitted: terminalEmitted,
      streamedAssistantText: false,
      threadId: "thread-parity",
      threadChatId: "chat-parity",
      timezone: "UTC",
      messages,
    });
    canonical.push(...result.canonicalEvents);
    nextCanonicalSeq = result.nextCanonicalSeqAfterBatch;
    runStartedEmitted = result.canonicalRunStartedEmittedAfterBatch;
    terminalEmitted = result.canonicalTerminalEmittedAfterBatch;
  }
  return canonical.flatMap((event) => mapCanonicalEventToAgui(event));
}

function projectDurableItems(
  items: readonly DurableAgUiHistoryItem[],
): Pick<NormalizedTranscript, "assistantText" | "tools" | "users"> {
  const assistantText: Record<string, string> = {};
  const tools: NormalizedTranscript["tools"] = {};
  const users: Record<string, string> = {};

  for (const raw of items) {
    const role = Reflect.get(raw, "role");
    if (role === "user") {
      const message = raw as Extract<Message, { role: "user" }>;
      users[message.id] =
        typeof message.content === "string" ? message.content : "";
      continue;
    }
    if (role === "assistant") {
      const message = raw as Extract<Message, { role: "assistant" }>;
      if (message.content && message.content.length > 0) {
        assistantText[message.id] = message.content;
      }
      for (const toolCall of message.toolCalls ?? []) {
        tools[toolCall.id] = {
          name: toolCall.function.name,
          argsText: toolCall.function.arguments,
          resultText: tools[toolCall.id]?.resultText ?? "",
          isError: tools[toolCall.id]?.isError ?? false,
        };
      }
      continue;
    }
    if (role === "tool") {
      const message = raw as Extract<Message, { role: "tool" }>;
      const existing = tools[message.toolCallId];
      tools[message.toolCallId] = {
        name: existing?.name ?? "",
        argsText: existing?.argsText ?? "",
        resultText: typeof message.content === "string" ? message.content : "",
        isError: typeof Reflect.get(message, "error") === "string",
      };
    }
  }

  return { assistantText, tools, users };
}

function expectedReasoning(
  events: readonly BaseEvent[],
): Record<string, string> {
  const reasoning: Record<string, string> = {};
  for (const event of events) {
    if (
      event.type === EventType.REASONING_MESSAGE_CONTENT ||
      event.type === EventType.REASONING_MESSAGE_CHUNK ||
      event.type === EventType.THINKING_TEXT_MESSAGE_CONTENT
    ) {
      const messageId = Reflect.get(event, "messageId");
      const delta = Reflect.get(event, "delta");
      if (typeof messageId === "string" && typeof delta === "string") {
        reasoning[messageId] = (reasoning[messageId] ?? "") + delta;
      }
    }
  }
  return reasoning;
}

function hasChunkEvents(events: readonly BaseEvent[]): boolean {
  return events.some((event) => event.type === EventType.TOOL_CALL_CHUNK);
}

function toEnvelopes(events: readonly BaseEvent[]): TranscriptEnvelope[] {
  return events.map((payload) => ({ payload, runId: RUN_ID }));
}

const recordingFiles = readdirSync(RECORDINGS_DIR).filter((file) =>
  file.endsWith(".jsonl"),
);

describe("TranscriptStore equivalence gate", () => {
  it("has recordings to replay", () => {
    expect(recordingFiles.length).toBeGreaterThan(0);
  });

  for (const file of recordingFiles) {
    it(`store projection matches the durable runtime projection for ${file}`, () => {
      const bodies = readRecordingBodies(file);
      const agent = inferAgent(file);
      const agUiEvents = buildAgUiStream(bodies, agent);

      const storeState = foldAgUiEnvelopes(toEnvelopes(agUiEvents));
      const storeProjection = projectTranscriptState(storeState);
      const durable = getDurableAgUiHistoryItemsFromEvents(agUiEvents);
      const durableProjection = projectDurableItems(durable.items);

      expect(storeProjection.assistantText).toEqual(
        durableProjection.assistantText,
      );
      expect(storeProjection.users).toEqual(durableProjection.users);

      if (!hasChunkEvents(agUiEvents)) {
        expect(storeProjection.tools).toEqual(durableProjection.tools);
      } else {
        const storeNames = Object.fromEntries(
          Object.entries(storeProjection.tools).map(([id, tool]) => [
            id,
            tool.name,
          ]),
        );
        const durableNames = Object.fromEntries(
          Object.entries(durableProjection.tools).map(([id, tool]) => [
            id,
            tool.name,
          ]),
        );
        expect(storeNames).toEqual(durableNames);
      }

      expect(storeProjection.reasoning).toEqual(expectedReasoning(agUiEvents));
    });
  }

  it("exercises substantive assistant text and tool content across recordings", () => {
    let assistantTextCount = 0;
    let toolCount = 0;
    for (const file of recordingFiles) {
      const agUiEvents = buildAgUiStream(
        readRecordingBodies(file),
        inferAgent(file),
      );
      const projection = projectTranscriptState(
        foldAgUiEnvelopes(toEnvelopes(agUiEvents)),
      );
      assistantTextCount += Object.keys(projection.assistantText).length;
      toolCount += Object.keys(projection.tools).length;
    }
    expect(assistantTextCount).toBeGreaterThan(0);
    expect(toolCount).toBeGreaterThan(0);
  });

  it("re-folding a replay overlap leaves the projection unchanged", () => {
    const file = recordingFiles.find((name) => name.includes("claude-code"));
    if (!file) return;
    const bodies = readRecordingBodies(file);
    const agUiEvents = buildAgUiStream(bodies, inferAgent(file));

    const envelopes = agUiEvents.map((payload, index) => ({
      payload,
      runId: RUN_ID,
      eventId: `evt-${index}`,
    }));

    const live = foldAgUiEnvelopes(envelopes);
    const withOverlap = foldAgUiEnvelopes(
      [...envelopes.slice(0, Math.ceil(envelopes.length / 2)), ...envelopes],
      undefined,
    );
    expect(projectTranscriptState(withOverlap)).toEqual(
      projectTranscriptState(live),
    );
  });
});
