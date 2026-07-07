import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalEvent } from "@terragon/agent/canonical-events";
import type {
  ClaudeMessage,
  DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import { buildCanonicalEventsForBatch } from "@terragon/daemon/daemon-canonical-events";
import { deriveDBMessagesFromCanonical } from "@terragon/shared/model/derive-db-messages-from-canonical";
import type { DBMessage } from "@terragon/shared";
import { describe, expect, it } from "vitest";
import { toDBMessage } from "./toDBMessage";

const RECORDINGS_DIR = join(__dirname, "../../../test/integration/recordings");

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

function foldToDBMessages(messages: ClaudeMessage[]): DBMessage[] {
  return messages.flatMap((message) => toDBMessage(message));
}

function foldCanonicalEvents(
  batches: ClaudeMessage[][],
  agent: "claudeCode" | "codex",
): CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let nextCanonicalSeq = 0;
  let runStartedEmitted = false;
  let terminalEmitted = false;
  for (const messages of batches) {
    const result = buildCanonicalEventsForBatch({
      runId: "run-parity",
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
    events.push(...result.canonicalEvents);
    nextCanonicalSeq = result.nextCanonicalSeqAfterBatch;
    runStartedEmitted = result.canonicalRunStartedEmittedAfterBatch;
    terminalEmitted = result.canonicalTerminalEmittedAfterBatch;
  }
  return events;
}

const recordingFiles = readdirSync(RECORDINGS_DIR).filter((f) =>
  f.endsWith(".jsonl"),
);

describe("Wave 4 canonical projection parity gate", () => {
  it("has recordings to test", () => {
    expect(recordingFiles.length).toBeGreaterThan(0);
  });

  for (const file of recordingFiles) {
    it(`DBMessage parity for ${file}`, () => {
      const bodies = readRecordingBodies(file);
      const agent = inferAgent(file);
      const batches = bodies.map((b) => (b.messages ?? []) as ClaudeMessage[]);
      const allMessages = batches.flat();

      const expected = foldToDBMessages(allMessages);
      const canonicalEvents = foldCanonicalEvents(batches, agent);
      const actual = deriveDBMessagesFromCanonical(canonicalEvents);

      expect(actual).toEqual(expected);
    });
  }
});
