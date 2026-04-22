import { NextRequest, NextResponse } from "next/server";
import { getTaskLivenessDebugPayloadForSecretScopedRoute } from "@/server-actions/admin/task-liveness-debug";
import { rejectTaskLivenessTestRequest } from "../../task-liveness-guard";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const rejected = rejectTaskLivenessTestRequest(request);
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

  const payload = await getTaskLivenessDebugPayloadForSecretScopedRoute({
    threadId,
  });
  return NextResponse.json(payload, { status: 200 });
}
