import { redis } from "./redis";

const STREAM_KEY_PREFIX = "thread:";
const STREAM_KEY_SUFFIX = ":messages";
const MAX_STREAM_LENGTH = 500;

function streamKey(threadId: string): string {
  return `${STREAM_KEY_PREFIX}${threadId}${STREAM_KEY_SUFFIX}`;
}

/**
 * Append a message batch to the per-thread Redis stream.
 * Uses XADD with approximate MAXLEN trimming to cap at 500 entries.
 */
export async function appendToMessageStream(
  threadId: string,
  seq: number,
  messages: unknown[],
): Promise<void> {
  const key = streamKey(threadId);
  await redis.xadd(
    key,
    "*",
    { seq: String(seq), data: JSON.stringify(messages) },
    {
      trim: { type: "MAXLEN", comparison: "~", threshold: MAX_STREAM_LENGTH },
    },
  );
}

/**
 * Replay messages from a thread's stream that have seq > lastSeq.
 * Uses XRANGE over the full stream and filters by seq field.
 * Returns entries sorted by seq ascending.
 */
export async function replayFromSeq(
  threadId: string,
  lastSeq: number,
): Promise<{ seq: number; messages: unknown[] }[]> {
  const key = streamKey(threadId);
  const entries = await redis.xrange(key, "-", "+");
  if (!entries || typeof entries !== "object") {
    return [];
  }

  const results: { seq: number; messages: unknown[] }[] = [];
  // xrange returns Record<streamId, Record<field, value>>
  for (const [, fields] of Object.entries(entries)) {
    const entrySeq = Number(fields.seq);
    if (entrySeq > lastSeq) {
      results.push({
        seq: entrySeq,
        messages: JSON.parse(fields.data as string),
      });
    }
  }

  return results.sort((a, b) => a.seq - b.seq);
}

/**
 * Delete a thread's message stream (cleanup on thread archive/delete).
 */
export async function clearMessageStream(threadId: string): Promise<void> {
  const key = streamKey(threadId);
  await redis.del(key);
}
