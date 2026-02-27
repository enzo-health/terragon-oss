import { db } from "@/lib/db";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { previewSession } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getPreviewCookieName } from "@/server-lib/preview-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hasPreviewCookie(request: Request, previewSessionId: string): boolean {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return false;
  }

  const cookieName = getPreviewCookieName(previewSessionId);
  return cookieHeader
    .split(";")
    .some((entry) => entry.trim().startsWith(`${cookieName}=`));
}

export async function GET(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ previewSessionId: string }>;
  },
) {
  const { previewSessionId } = await params;

  const session = await db.query.previewSession.findFirst({
    where: eq(previewSession.previewSessionId, previewSessionId),
    columns: {
      userId: true,
      state: true,
      previewOpenMode: true,
      previewRequiresWebsocket: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!session) {
    return NextResponse.json(
      { error: "Preview session not found" },
      { status: 404 },
    );
  }

  if (session.userId) {
    const isPreviewEnabled = await getFeatureFlagForUser({
      db,
      userId: session.userId,
      flagName: "sandboxPreview",
    });
    if (!isPreviewEnabled) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  if (
    session.revokedAt ||
    (session.expiresAt && session.expiresAt.getTime() <= Date.now())
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "expired",
        state: session.state,
      },
      { status: 200 },
    );
  }

  if (session.previewRequiresWebsocket) {
    return NextResponse.json(
      {
        ok: false,
        code: "ws_required",
        state: session.state,
      },
      { status: 200 },
    );
  }

  const cookiePresent = hasPreviewCookie(request, previewSessionId);
  if (!cookiePresent) {
    return NextResponse.json(
      {
        ok: false,
        code: "cookie_blocked",
        state: session.state,
      },
      { status: 200 },
    );
  }

  return NextResponse.json({
    ok: true,
    state: session.state,
    openMode: session.previewOpenMode,
  });
}
