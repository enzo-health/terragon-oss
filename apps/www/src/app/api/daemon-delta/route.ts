import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { publishDeltaBroadcast } from "@terragon/shared/broadcast-server";
import type { DaemonDelta } from "@terragon/daemon/shared";
import { appendTokenStreamEvents } from "@terragon/shared/model/token-stream-event";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";

type DaemonDeltaBody = {
  threadId: string;
  threadChatId: string;
  deltas: DaemonDelta[];
};

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
  if (
    claims &&
    (claims.threadId !== threadId || claims.threadChatId !== threadChatId)
  ) {
    return Response.json(
      { success: false, error: "daemon_delta_claim_mismatch" },
      { status: 401 },
    );
  }

  const tokenEvents = await appendTokenStreamEvents({
    db,
    events: deltas.map((delta, index) => ({
      userId,
      threadId,
      threadChatId,
      messageId: delta.messageId,
      partIndex: delta.partIndex,
      text: delta.text,
      idempotencyKey: claims
        ? `${threadChatId}:${claims.runId}:delta:${delta.deltaSeq}:${index}`
        : `${threadChatId}:${delta.messageId}:${delta.partIndex}:${delta.deltaSeq}:${randomUUID()}`,
    })),
  });

  await Promise.all(
    tokenEvents.map((event) =>
      publishDeltaBroadcast({
        userId,
        threadId,
        threadChatId,
        messageId: event.messageId,
        partIndex: event.partIndex,
        deltaSeq: event.streamSeq,
        deltaIdempotencyKey: event.idempotencyKey,
        text: event.text,
      }),
    ),
  );

  return Response.json({ success: true });
}
