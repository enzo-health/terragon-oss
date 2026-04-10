import type { DaemonDelta } from "@leo/daemon/shared";

export type DeltaSequenceKey =
  `${string}:${string}:${number}:${"text" | "thinking"}`;

type IndexedDelta = {
  delta: DaemonDelta;
  index: number;
};

type ParsedSequence = {
  messageId: string;
  partIndex: number;
  kind: "text" | "thinking";
};

function parseSequence(delta: DaemonDelta): ParsedSequence {
  return {
    messageId: delta.messageId,
    partIndex: delta.partIndex,
    kind: delta.kind === "thinking" ? "thinking" : "text",
  };
}

export function buildDeltaSequenceKey(params: {
  runId: string;
  messageId: string;
  partIndex: number;
  kind?: "text" | "thinking";
}): DeltaSequenceKey {
  const kind = params.kind === "thinking" ? "thinking" : "text";
  return `${params.runId}:${params.messageId}:${params.partIndex}:${kind}`;
}

export function normalizeDeltasForPersistence(
  deltas: DaemonDelta[],
): DaemonDelta[] {
  const groups = new Map<string, IndexedDelta[]>();

  for (let i = 0; i < deltas.length; i++) {
    const delta = deltas[i];
    if (!delta?.messageId || !Number.isFinite(delta.partIndex)) {
      continue;
    }
    if (!Number.isFinite(delta.deltaSeq) || delta.deltaSeq < 0) {
      continue;
    }
    if (!delta.text) {
      continue;
    }
    const key = `${delta.messageId}:${delta.partIndex}:${delta.kind === "thinking" ? "thinking" : "text"}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push({ delta, index: i });
      continue;
    }
    groups.set(key, [{ delta, index: i }]);
  }

  const normalized: IndexedDelta[] = [];
  for (const entries of groups.values()) {
    entries.sort((a, b) => {
      if (a.delta.deltaSeq !== b.delta.deltaSeq) {
        return a.delta.deltaSeq - b.delta.deltaSeq;
      }
      return a.index - b.index;
    });

    let lastSeq = -1;
    for (const entry of entries) {
      if (entry.delta.deltaSeq <= lastSeq) {
        continue;
      }
      lastSeq = entry.delta.deltaSeq;
      normalized.push(entry);
    }
  }

  normalized.sort((a, b) => {
    const aSeq = parseSequence(a.delta);
    const bSeq = parseSequence(b.delta);
    if (aSeq.messageId !== bSeq.messageId) {
      return aSeq.messageId.localeCompare(bSeq.messageId);
    }
    if (aSeq.partIndex !== bSeq.partIndex) {
      return aSeq.partIndex - bSeq.partIndex;
    }
    if (aSeq.kind !== bSeq.kind) {
      return aSeq.kind === "thinking" ? -1 : 1;
    }
    if (a.delta.deltaSeq !== b.delta.deltaSeq) {
      return a.delta.deltaSeq - b.delta.deltaSeq;
    }
    return a.index - b.index;
  });
  return normalized.map((entry) => entry.delta);
}

export function filterDeltasByKnownMaxSeq(params: {
  deltas: DaemonDelta[];
  runId: string;
  maxSeqByKey: Map<DeltaSequenceKey, number>;
}): DaemonDelta[] {
  return params.deltas.filter((delta) => {
    const key = buildDeltaSequenceKey({
      runId: params.runId,
      messageId: delta.messageId,
      partIndex: delta.partIndex,
      kind: delta.kind === "thinking" ? "thinking" : "text",
    });
    const knownMax = params.maxSeqByKey.get(key);
    if (knownMax == null) {
      return true;
    }
    return delta.deltaSeq > knownMax;
  });
}

export function computeMaxSeqByKey(params: {
  deltas: DaemonDelta[];
  runId: string;
}): Map<DeltaSequenceKey, number> {
  const result = new Map<DeltaSequenceKey, number>();
  for (const delta of params.deltas) {
    const key = buildDeltaSequenceKey({
      runId: params.runId,
      messageId: delta.messageId,
      partIndex: delta.partIndex,
      kind: delta.kind === "thinking" ? "thinking" : "text",
    });
    const previous = result.get(key);
    if (previous == null || delta.deltaSeq > previous) {
      result.set(key, delta.deltaSeq);
    }
  }
  return result;
}
