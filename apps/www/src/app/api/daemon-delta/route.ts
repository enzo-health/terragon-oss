import { getDaemonTokenAuthContextOrNull } from "@/lib/auth-server";
import { publishDeltaBroadcast } from "@terragon/shared/broadcast-server";
import type { DaemonDelta } from "@terragon/daemon/shared";

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

  // Broadcast all deltas in parallel — fire-and-forget, no DB write
  await Promise.all(
    deltas.map((delta) =>
      publishDeltaBroadcast({
        userId,
        threadId,
        threadChatId,
        messageId: delta.messageId,
        partIndex: delta.partIndex,
        text: delta.text,
      }),
    ),
  );

  return Response.json({ success: true });
}
