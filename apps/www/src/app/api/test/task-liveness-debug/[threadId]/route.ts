import { env } from "@terragon/env/apps-www";
import { NextRequest, NextResponse } from "next/server";
import { getTaskLivenessDebugPayload } from "@/server-actions/admin/task-liveness-debug";

function rejectWhenUnavailable(request: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "Not found" },
      {
        status: 404,
      },
    );
  }

  const secret = request.headers.get("X-Terragon-Secret");
  if (secret !== env.INTERNAL_SHARED_SECRET) {
    return NextResponse.json(
      { error: "Unauthorized" },
      {
        status: 401,
      },
    );
  }

  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const rejected = rejectWhenUnavailable(request);
  if (rejected) {
    return rejected;
  }

  const { threadId } = await params;
  if (!threadId) {
    return NextResponse.json(
      { error: "threadId is required" },
      {
        status: 400,
      },
    );
  }

  const payload = await getTaskLivenessDebugPayload({ threadId });
  return NextResponse.json(payload, { status: 200 });
}
