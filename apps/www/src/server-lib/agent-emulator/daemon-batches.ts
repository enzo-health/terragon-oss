import { createHash } from "node:crypto";
import { EVENT_ENVELOPE_VERSION } from "@terragon/agent/canonical-events";
import { buildCanonicalEventsForBatch } from "@terragon/daemon/daemon-canonical-events";
import type {
  ClaudeMessage,
  DaemonDelta,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";

export const EMULATOR_AGENT = "claudeCode" as const;
export const EMULATOR_TRANSPORT_MODE = "acp" as const;
export const EMULATOR_PROTOCOL_VERSION = 2 as const;
export const EMULATOR_SESSION_ID = "emulator-session";

export type EmulatorRunState = {
  runId: string;
  threadId: string;
  threadChatId: string;
  timezone: string;
  nextSeq: number;
  nextCanonicalSeq: number;
  nextDeltaSeq: number;
  canonicalRunStartedEmitted: boolean;
  canonicalTerminalEmitted: boolean;
  streamedAssistantText: boolean;
};

export function createEmulatorRunState(params: {
  runId: string;
  threadId: string;
  threadChatId: string;
  timezone: string;
}): EmulatorRunState {
  return {
    runId: params.runId,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
    timezone: params.timezone,
    nextSeq: 0,
    nextCanonicalSeq: 0,
    nextDeltaSeq: 0,
    canonicalRunStartedEmitted: false,
    canonicalTerminalEmitted: false,
    streamedAssistantText: true,
  };
}

function envelopeEventId(runId: string, seq: number, suffix?: string): string {
  const material = suffix ? `${runId}:${seq}:${suffix}` : `${runId}:${seq}`;
  return createHash("sha256").update(material).digest("hex");
}

export function buildMessagesBatch(
  state: EmulatorRunState,
  messages: ClaudeMessage[],
): DaemonEventAPIBody {
  const seq = state.nextSeq;
  state.nextSeq += 1;
  const built = buildCanonicalEventsForBatch({
    runId: state.runId,
    agent: EMULATOR_AGENT,
    model: null,
    transportMode: EMULATOR_TRANSPORT_MODE,
    protocolVersion: EMULATOR_PROTOCOL_VERSION,
    nextCanonicalSeq: state.nextCanonicalSeq,
    canonicalRunStartedEmitted: state.canonicalRunStartedEmitted,
    canonicalTerminalEmitted: state.canonicalTerminalEmitted,
    streamedAssistantText: state.streamedAssistantText,
    threadId: state.threadId,
    threadChatId: state.threadChatId,
    timezone: state.timezone,
    messages,
  });
  state.nextCanonicalSeq = built.nextCanonicalSeqAfterBatch;
  state.canonicalRunStartedEmitted = built.canonicalRunStartedEmittedAfterBatch;
  state.canonicalTerminalEmitted = built.canonicalTerminalEmittedAfterBatch;
  return {
    threadId: state.threadId,
    threadChatId: state.threadChatId,
    messages,
    timezone: state.timezone,
    transportMode: EMULATOR_TRANSPORT_MODE,
    protocolVersion: EMULATOR_PROTOCOL_VERSION,
    payloadVersion: EVENT_ENVELOPE_VERSION,
    eventId: envelopeEventId(state.runId, seq),
    runId: state.runId,
    seq,
    canonicalEvents: built.canonicalEvents,
  };
}

export type EmulatorDeltaInput = {
  messageId: string;
  partIndex: number;
  kind: "text" | "thinking" | "tool-output";
  text: string;
  toolCallId?: string;
  stream?: "stdout" | "stderr" | "progress";
};

export function buildDeltaBatch(
  state: EmulatorRunState,
  deltaInputs: EmulatorDeltaInput[],
): DaemonEventAPIBody {
  const seq = state.nextSeq;
  state.nextSeq += 1;
  const deltas: DaemonDelta[] = deltaInputs.map((input) => {
    const deltaSeq = state.nextDeltaSeq;
    state.nextDeltaSeq += 1;
    return {
      messageId: input.messageId,
      partIndex: input.partIndex,
      deltaSeq,
      kind: input.kind,
      text: input.text,
      ...(input.toolCallId !== undefined
        ? { toolCallId: input.toolCallId }
        : {}),
      ...(input.stream !== undefined ? { stream: input.stream } : {}),
    };
  });
  return {
    threadId: state.threadId,
    threadChatId: state.threadChatId,
    messages: [],
    timezone: state.timezone,
    transportMode: EMULATOR_TRANSPORT_MODE,
    protocolVersion: EMULATOR_PROTOCOL_VERSION,
    payloadVersion: EVENT_ENVELOPE_VERSION,
    eventId: envelopeEventId(state.runId, seq, "delta-only"),
    runId: state.runId,
    seq,
    deltas,
  };
}
