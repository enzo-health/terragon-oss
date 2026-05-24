import type { RunAgentInput } from "@ag-ui/core";
import {
  decodeTerragonAgUiRunConfig,
  type TerragonAgUiPostIntent,
} from "./terragon-ag-ui-run-config";

export type AgUiReplayCursor = {
  seq: number;
  projectionIndex: number | null;
};

export function parseAgUiReplayCursor(
  value: string | null,
): AgUiReplayCursor | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }
  const trimmed = value.trim();
  const normalized = trimmed.startsWith("seq:")
    ? trimmed.slice("seq:".length)
    : trimmed;
  const [seqValue, projectionIndexValue] = normalized.split(":");
  const seq = Number(seqValue);
  if (!Number.isSafeInteger(seq) || seq < -1) {
    return null;
  }
  if (projectionIndexValue === undefined) {
    return { seq, projectionIndex: null };
  }
  const projectionIndex = Number(projectionIndexValue);
  return Number.isSafeInteger(projectionIndex) && projectionIndex >= 0
    ? { seq, projectionIndex }
    : null;
}

export function serializeAgUiReplayCursor(cursor: AgUiReplayCursor): string {
  return cursor.projectionIndex === null
    ? String(cursor.seq)
    : `${cursor.seq}:${cursor.projectionIndex}`;
}

export function resolveAgUiReplayCursor({
  lastEventId,
  fromSeq,
}: {
  lastEventId: string | null;
  fromSeq: string | null;
}): AgUiReplayCursor | null {
  const lastEventCursor = parseAgUiReplayCursor(lastEventId);
  if (lastEventCursor !== null) {
    return lastEventCursor;
  }
  return parseAgUiReplayCursor(fromSeq);
}

export function replayQueryAfterSeq(
  cursor: AgUiReplayCursor | null,
): number | undefined {
  if (cursor === null) {
    return undefined;
  }
  return cursor.projectionIndex === null ? cursor.seq : cursor.seq - 1;
}

export function shouldReplayEnvelope(
  entry: { seq: number; projectionIndex?: number | null },
  cursor: AgUiReplayCursor | null,
): boolean {
  if (cursor === null) {
    return true;
  }
  if (entry.seq > cursor.seq) {
    return true;
  }
  if (entry.seq < cursor.seq || cursor.projectionIndex === null) {
    return false;
  }
  return (entry.projectionIndex ?? 0) > cursor.projectionIndex;
}

export function classifyAgUiPostIntent({
  lastEventId,
  fromSeq,
  body,
}: {
  lastEventId: string | null;
  fromSeq: string | null;
  body: Pick<RunAgentInput, "forwardedProps">;
}): TerragonAgUiPostIntent {
  if (resolveAgUiReplayCursor({ lastEventId, fromSeq }) !== null) {
    return "resume";
  }
  return decodeTerragonAgUiRunConfig(body.forwardedProps).intent;
}
