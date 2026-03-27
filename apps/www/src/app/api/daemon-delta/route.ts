import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { publishDeltaBroadcast } from "@terragon/shared/broadcast-server";
import type { DaemonDelta } from "@terragon/daemon/shared";
import { appendTokenStreamEvents } from "@terragon/shared/model/token-stream-event";
import { db } from "@/lib/db";

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

  const tokenEvents = await appendTokenStreamEvents({
    db,
    events: deltas.map((delta, index) => ({
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
