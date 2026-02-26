import {
  getUserIdOrNull,
  getUserIdOrNullFromDaemonToken,
} from "@/lib/auth-server";
import { db } from "@/lib/db";
import { NextResponse } from "next/server";
import { parseBroadcastChannel } from "@terragon/types/broadcast";
import { assertNever } from "@terragon/shared/utils";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import {
  consumePreviewBroadcastJti,
  mapPreviewAuthError,
  verifyPreviewBroadcastToken,
} from "@/server-lib/preview-auth";
import { previewSession } from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return authorization.slice(7).trim() || null;
}

// Validate that the current user is allowed to listen to the given broadcast channel.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get("channel") ?? "";
  const parsedChannel = parseBroadcastChannel(channel);
  if (!parsedChannel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const userId =
    (await getUserIdOrNullFromDaemonToken(request)) ??
    (await getUserIdOrNull());
  switch (parsedChannel.type) {
    case "preview": {
      const token = getBearerToken(request);
      if (!token) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      let claims;
      try {
        claims = await verifyPreviewBroadcastToken({ token });
        await consumePreviewBroadcastJti({ jti: claims.jti });
      } catch (error) {
        const mapped = mapPreviewAuthError(error);
        return NextResponse.json(
          { code: mapped.code, error: mapped.message },
          { status: mapped.status },
        );
      }

      if (
        parsedChannel.previewSessionId !== claims.previewSessionId ||
        parsedChannel.threadId !== claims.threadId ||
        parsedChannel.threadChatId !== claims.threadChatId ||
        parsedChannel.runId !== claims.runId ||
        parsedChannel.userId !== claims.userId ||
        parsedChannel.schemaVersion !== claims.schemaVersion
      ) {
        return NextResponse.json(
          { code: "binding_mismatch", error: "Preview channel mismatch" },
          { status: 403 },
        );
      }

      if (userId && claims.userId !== userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const session = await db.query.previewSession.findFirst({
        where: eq(previewSession.previewSessionId, claims.previewSessionId),
        columns: {
          threadId: true,
          threadChatId: true,
          runId: true,
          userId: true,
          revocationVersion: true,
          expiresAt: true,
          revokedAt: true,
          state: true,
        },
      });
      if (!session) {
        return NextResponse.json(
          { error: "Preview session not found" },
          { status: 404 },
        );
      }

      if (
        session.threadId !== claims.threadId ||
        session.threadChatId !== claims.threadChatId ||
        session.runId !== claims.runId ||
        session.userId !== claims.userId
      ) {
        return NextResponse.json(
          { code: "binding_mismatch", error: "Preview session mismatch" },
          { status: 403 },
        );
      }

      if (
        session.revokedAt ||
        (session.expiresAt && session.expiresAt.getTime() <= Date.now())
      ) {
        return NextResponse.json(
          { code: "revoked", error: "Preview session revoked" },
          { status: 401 },
        );
      }

      return NextResponse.json({ message: "ok" });
    }
    case "user": {
      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (parsedChannel.id !== userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.json({ message: "ok" });
    }
    case "sandbox": {
      if (!userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      if (parsedChannel.userId !== userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const thread = await getThreadMinimal({
        db,
        userId,
        threadId: parsedChannel.threadId,
      });
      if (!thread) {
        return NextResponse.json(
          { error: "Thread not found" },
          { status: 404 },
        );
      }
      if (thread.codesandboxId !== parsedChannel.sandboxId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return NextResponse.json({ message: "ok" });
    }
    default: {
      assertNever(parsedChannel);
    }
  }
}
