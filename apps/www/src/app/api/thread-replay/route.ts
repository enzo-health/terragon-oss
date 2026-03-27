import { NextRequest, NextResponse } from "next/server";
import { getSessionOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { replayFromSeq } from "@/lib/message-stream";
import { replayTokenStreamEventsFromSeq } from "@terragon/shared/model/token-stream-event";

export async function GET(request: NextRequest) {
  const session = await getSessionOrNull();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const threadId = request.nextUrl.searchParams.get("threadId");
  const fromSeqStr = request.nextUrl.searchParams.get("fromSeq");
  const threadChatId = request.nextUrl.searchParams.get("threadChatId");
  const fromDeltaSeqStr = request.nextUrl.searchParams.get("fromDeltaSeq");

  if (!threadId || !fromSeqStr) {
    return NextResponse.json(
      { error: "Missing threadId or fromSeq" },
      { status: 400 },
    );
  }

  const fromSeq = parseInt(fromSeqStr, 10);
  if (!Number.isFinite(fromSeq) || fromSeq < 0) {
    return NextResponse.json({ error: "Invalid fromSeq" }, { status: 400 });
  }

  let fromDeltaSeq: number | null = null;
  if (fromDeltaSeqStr != null) {
    const parsedFromDeltaSeq = parseInt(fromDeltaSeqStr, 10);
    if (!Number.isFinite(parsedFromDeltaSeq) || parsedFromDeltaSeq < 0) {
      return NextResponse.json(
        { error: "Invalid fromDeltaSeq" },
        { status: 400 },
      );
    }
    fromDeltaSeq = parsedFromDeltaSeq;
  }

  if (
    (threadChatId && fromDeltaSeq == null) ||
    (!threadChatId && fromDeltaSeq != null)
  ) {
    return NextResponse.json(
      { error: "threadChatId and fromDeltaSeq must be provided together" },
      { status: 400 },
    );
  }

  // Verify thread ownership
  const thread = await db
    .select({ id: schema.thread.id })
    .from(schema.thread)
    .where(
      and(
        eq(schema.thread.id, threadId),
        eq(schema.thread.userId, session.user.id),
      ),
    )
    .limit(1);

  if (thread.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const entries = await replayFromSeq(threadId, fromSeq);
  const deltaEntries =
    threadChatId && fromDeltaSeq != null
      ? await replayTokenStreamEventsFromSeq({
          db,
          userId: session.user.id,
          threadId,
          threadChatId,
          fromSeq: fromDeltaSeq,
        })
      : [];
  return NextResponse.json({ entries, deltaEntries });
}
