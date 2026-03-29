import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { publishDeltaBroadcast } from "@terragon/shared/broadcast-server";
import type { DaemonDelta } from "@terragon/daemon/shared";
import { appendTokenStreamEvents } from "@terragon/shared/model/token-stream-event";
import { db } from "@/lib/db";
import {
  isLocalRedisHttpMode,
  isRedisTransportParseError,
  redis,
} from "@/lib/redis";
import { getDaemonEventDbPreflight } from "@/server-lib/daemon-event-db-preflight";
import {
  buildDeltaSequenceKey,
  computeMaxSeqByKey,
  type DeltaSequenceKey,
  filterDeltasByKnownMaxSeq,
  normalizeDeltasForPersistence,
} from "@/server-lib/token-stream-guards";

type DaemonDeltaBody = {
  threadId: string;
  threadChatId: string;
  deltas: DaemonDelta[];
};

const DELTA_SEQ_MAX_TTL_SECONDS = 60 * 60 * 24;

function isMissingSchemaError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "42P01" || code === "42703";
}

function getDeltaSeqMaxRedisKey(sequenceKey: string): string {
  return `sdlc:delta-seq-max:${sequenceKey}`;
}

async function getKnownMaxDeltaSeqByKey(params: {
  runId: string;
  deltas: DaemonDelta[];
}): Promise<Map<DeltaSequenceKey, number>> {
  const result = new Map<DeltaSequenceKey, number>();
  if (params.deltas.length === 0 || isLocalRedisHttpMode()) {
    return result;
  }
  for (const delta of params.deltas) {
    const sequenceKey = buildDeltaSequenceKey({
      runId: params.runId,
      messageId: delta.messageId,
      partIndex: delta.partIndex,
      kind: delta.kind === "thinking" ? "thinking" : "text",
    });
    if (result.has(sequenceKey)) {
      continue;
    }
    try {
      const raw = await redis.get<string>(getDeltaSeqMaxRedisKey(sequenceKey));
      const parsed = raw == null ? Number.NaN : Number(raw);
      if (Number.isFinite(parsed)) {
        result.set(sequenceKey, parsed);
      }
    } catch (error) {
      if (isLocalRedisHttpMode() && isRedisTransportParseError(error)) {
        console.warn(
          "[daemon-delta] local redis delta max-seq read parse failure, bypassing",
          { sequenceKey },
        );
        return new Map();
      }
      throw error;
    }
  }
  return result;
}

async function persistKnownMaxDeltaSeqByKey(params: {
  runId: string;
  deltas: DaemonDelta[];
}): Promise<void> {
  if (params.deltas.length === 0 || isLocalRedisHttpMode()) {
    return;
  }
  const maxByKey = computeMaxSeqByKey({
    runId: params.runId,
    deltas: params.deltas,
  });
  for (const [sequenceKey, maxSeq] of maxByKey) {
    try {
      await redis.set(getDeltaSeqMaxRedisKey(sequenceKey), String(maxSeq), {
        ex: DELTA_SEQ_MAX_TTL_SECONDS,
      });
    } catch (error) {
      if (isLocalRedisHttpMode() && isRedisTransportParseError(error)) {
        console.warn(
          "[daemon-delta] local redis delta max-seq write parse failure, bypassing",
          { sequenceKey, maxSeq },
        );
        return;
      }
      throw error;
    }
  }
}

export async function POST(request: Request) {
  const daemonAuthContext = await getDaemonTokenAuthContextOrNull(request);
  if (!daemonAuthContext) {
    return new Response("Unauthorized", { status: 401 });
  }

  const json: DaemonDeltaBody = await request.json();
  const { threadId, threadChatId, deltas } = json;

  if (
    !threadId ||
    !threadChatId ||
    !Array.isArray(deltas) ||
    deltas.length === 0
  ) {
    return Response.json(
      { success: false, error: "invalid_body" },
      { status: 400 },
    );
  }

  const userId = daemonAuthContext.userId;
  const claims = daemonAuthContext.claims;
  if (!claims) {
    return Response.json(
      { success: false, error: "daemon_delta_missing_claims" },
      { status: 401 },
    );
  }
  if (claims.threadId !== threadId || claims.threadChatId !== threadChatId) {
    return Response.json(
      { success: false, error: "daemon_delta_claim_mismatch" },
      { status: 401 },
    );
  }

  const dbPreflight = await getDaemonEventDbPreflight(db);
  const normalizedDeltas = normalizeDeltasForPersistence(deltas);
  const knownMaxSeqByKey = await getKnownMaxDeltaSeqByKey({
    runId: claims.runId,
    deltas: normalizedDeltas,
  });
  const acceptedDeltas = filterDeltasByKnownMaxSeq({
    deltas: normalizedDeltas,
    runId: claims.runId,
    maxSeqByKey: knownMaxSeqByKey,
  });
  await persistKnownMaxDeltaSeqByKey({
    runId: claims.runId,
    deltas: acceptedDeltas,
  });

  if (acceptedDeltas.length === 0) {
    return Response.json({ success: true, deduplicated: true });
  }

  if (!dbPreflight.tokenStreamEventReady) {
    for (const [index, delta] of acceptedDeltas.entries()) {
      await publishDeltaBroadcast({
        userId,
        threadId,
        threadChatId,
        messageId: delta.messageId,
        partIndex: delta.partIndex,
        deltaSeq: delta.deltaSeq,
        deltaIdempotencyKey: `${threadChatId}:${claims.runId}:preflight-fallback:${delta.messageId}:${delta.partIndex}:${delta.deltaSeq}:${index}`,
        deltaKind: delta.kind === "thinking" ? "thinking" : "text",
        text: delta.text,
      });
    }
    return Response.json({ success: true, persisted: false });
  }

  let tokenEvents: Awaited<ReturnType<typeof appendTokenStreamEvents>>;
  try {
    tokenEvents = await appendTokenStreamEvents({
      db,
      events: acceptedDeltas.map((delta, index) => ({
        userId,
        threadId,
        threadChatId,
        messageId: delta.messageId,
        partIndex: delta.partIndex,
        partType: delta.kind === "thinking" ? "thinking" : "text",
        text: delta.text,
        idempotencyKey: `${threadChatId}:${claims.runId}:delta:${delta.messageId}:${delta.partIndex}:${delta.deltaSeq}:${index}`,
      })),
    });
  } catch (error) {
    if (!isMissingSchemaError(error)) {
      throw error;
    }
    for (const [index, delta] of acceptedDeltas.entries()) {
      await publishDeltaBroadcast({
        userId,
        threadId,
        threadChatId,
        messageId: delta.messageId,
        partIndex: delta.partIndex,
        deltaSeq: delta.deltaSeq,
        deltaIdempotencyKey: `${threadChatId}:${claims.runId}:missing-schema-fallback:${delta.messageId}:${delta.partIndex}:${delta.deltaSeq}:${index}`,
        deltaKind: delta.kind === "thinking" ? "thinking" : "text",
        text: delta.text,
      });
    }
    return Response.json({ success: true, persisted: false });
  }

  const orderedTokenEvents = [...tokenEvents].sort(
    (a, b) => a.streamSeq - b.streamSeq,
  );
  for (const event of orderedTokenEvents) {
    await publishDeltaBroadcast({
      userId,
      threadId,
      threadChatId,
      messageId: event.messageId,
      partIndex: event.partIndex,
      deltaSeq: event.streamSeq,
      deltaIdempotencyKey: event.idempotencyKey,
      deltaKind: event.partType === "thinking" ? "thinking" : "text",
      text: event.text,
    });
  }

  return Response.json({ success: true });
}
