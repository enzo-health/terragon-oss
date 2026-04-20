import { NextRequest, NextResponse } from "next/server";
import { getSessionOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { eq, and } from "drizzle-orm";
import * as schema from "@terragon/shared/db/schema";
import { getThreadReplayEntriesFromCanonicalEvents } from "@terragon/shared/model/agent-event-log";

export async function GET(request: NextRequest) {
  const session = await getSessionOrNull();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const threadId = request.nextUrl.searchParams.get("threadId");
  const fromSeqStr = request.nextUrl.searchParams.get("fromSeq");
  const threadChatId = request.nextUrl.searchParams.get("threadChatId");

  if (!threadId) {
    return NextResponse.json({ error: "Missing threadId" }, { status: 400 });
  }

  let fromSeq: number | null = null;
  if (fromSeqStr != null) {
    const parsedFromSeq = parseInt(fromSeqStr, 10);
    if (!Number.isFinite(parsedFromSeq) || parsedFromSeq < 0) {
      return NextResponse.json({ error: "Invalid fromSeq" }, { status: 400 });
    }
    fromSeq = parsedFromSeq;
  }

  if (fromSeq == null) {
    return NextResponse.json(
      { error: "Missing replay cursor (fromSeq)" },
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

  const entries = await getThreadReplayEntriesFromCanonicalEvents({
    db,
    threadId,
    fromThreadChatMessageSeq: fromSeq,
    ...(threadChatId ? { threadChatId } : {}),
  });
  // Phase 6 deletes this route outright. Until then the response shape is
  // frozen so pre-cutover clients keep parsing; `deltaEntries` is always
  // empty because token_stream_event was deleted in Task 2C.
  return NextResponse.json({ entries, deltaEntries: [] });
}
