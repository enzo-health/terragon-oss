/**
 * POST /api/ag-ui/[threadId]/cancel?threadChatId=...
 *
 * Cancel adapter: bridges the runtime's cancel intent to `stopThreadInternal`.
 *
 * HttpAgent.cancel() aborts the SSE stream client-side but sends no server
 * signal. This endpoint provides the explicit server-side cancel path that the
 * frontend (Wave 3) calls via an `onCancel` callback alongside `core.cancel()`.
 *
 * @see docs/plans/2026-04-30-runtime-owns-writes-adr.md — "Cancel mirror" section
 * @see apps/www/src/server-lib/cancel-from-ag-ui.ts — adapter implementation
 */

import { NextResponse, type NextRequest } from "next/server";
import { getSessionOrNull } from "@/lib/auth-server";
import { cancelThreadFromAgUiInput } from "@/server-lib/cancel-from-ag-ui";

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ threadId: string }> },
): Promise<Response> {
  // 1. Resolve threadId from dynamic segment
  const { threadId } = await ctx.params;

  // 2. Authenticate — same session lookup as the main AG-UI GET/POST route
  const session = await getSessionOrNull();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // 3. Resolve threadChatId from query param
  const threadChatId = request.nextUrl.searchParams.get("threadChatId");
  if (!threadChatId) {
    return NextResponse.json(
      { error: "Missing threadChatId" },
      { status: 400 },
    );
  }

  // 4. Detect replay mode via X-Terragon-Test-Replay header (any truthy value)
  const isReplayMode = !!request.headers.get("X-Terragon-Test-Replay");

  // 5. Delegate to the adapter
  const result = await cancelThreadFromAgUiInput({
    threadId,
    threadChatId,
    userId,
    isReplayMode,
  });

  // 6. Map adapter result → HTTP response
  if ("skipped" in result) {
    // Replay mode — no-op, return 200 with context so callers can assert
    return NextResponse.json({ skipped: result.skipped }, { status: 200 });
  }

  if ("error" in result) {
    const { kind } = result.error;
    if (kind === "unauthorized" || kind === "thread-not-found") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  // { ok: true }
  return NextResponse.json({ ok: true }, { status: 200 });
}
