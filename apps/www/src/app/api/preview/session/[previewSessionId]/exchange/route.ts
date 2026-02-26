import { db } from "@/lib/db";
import {
  enforcePreviewRateLimit,
  PreviewRateLimitError,
} from "@/lib/rate-limit";
import {
  createPreviewServiceUnavailablePayload,
  getClientIpFromRequest,
  getPreviewCookieName,
  mapPreviewAuthError,
  mintPreviewBroadcastToken,
  mintPreviewCookieToken,
  verifyAndConsumePreviewExchangeToken,
} from "@/server-lib/preview-auth";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { previewSession } from "@terragon/shared/db/schema";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getBroadcastChannelStr } from "@terragon/types/broadcast";
import {
  previewBroadcastSchemaVersion,
  previewSessionTTLSeconds,
} from "@terragon/shared/types/preview";
import { z } from "zod/v4";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const exchangeBodySchema = z.object({
  exchangeToken: z.string().optional(),
  openMode: z.enum(["iframe", "new_tab"]).optional(),
});

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  return authorization.slice(7).trim() || null;
}

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ previewSessionId: string }>;
  },
) {
  const { previewSessionId } = await params;

  const bodyResult = exchangeBodySchema.safeParse(await request.json());
  if (!bodyResult.success) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        issues: bodyResult.error.issues,
      },
      { status: 400 },
    );
  }

  const exchangeToken =
    getBearerToken(request) ?? bodyResult.data.exchangeToken;
  if (!exchangeToken) {
    return NextResponse.json(
      {
        error: "Missing exchange token",
      },
      { status: 401 },
    );
  }

  let exchangeClaims;
  try {
    exchangeClaims = await verifyAndConsumePreviewExchangeToken({
      token: exchangeToken,
      expectedPreviewSessionId: previewSessionId,
    });
  } catch (error) {
    const mapped = mapPreviewAuthError(error);
    if (mapped.code === "cache_unavailable") {
      const payload = createPreviewServiceUnavailablePayload();
      return NextResponse.json(payload, {
        status: 503,
        headers: {
          "Retry-After": `${Math.ceil(payload.retryAfterMs / 1000)}`,
        },
      });
    }

    return NextResponse.json(
      {
        code: mapped.code,
        error: mapped.message,
      },
      { status: mapped.status },
    );
  }

  const isPreviewEnabled = await getFeatureFlagForUser({
    db,
    userId: exchangeClaims.userId,
    flagName: "sandboxPreview",
  });
  if (!isPreviewEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { ip } = getClientIpFromRequest(request);
  try {
    await enforcePreviewRateLimit({
      scope: "exchange",
      userId: exchangeClaims.userId,
      ip,
    });
  } catch (error) {
    if (error instanceof PreviewRateLimitError) {
      return NextResponse.json(
        {
          code: "rate_limited",
          limiter: error.dimension,
          nextAllowedAt: error.nextAllowedAt,
        },
        { status: 429 },
      );
    }
    throw error;
  }

  const session = await db.query.previewSession.findFirst({
    where: eq(previewSession.previewSessionId, previewSessionId),
    columns: {
      previewSessionId: true,
      threadId: true,
      threadChatId: true,
      runId: true,
      userId: true,
      codesandboxId: true,
      sandboxProvider: true,
      state: true,
      revocationVersion: true,
      expiresAt: true,
      revokedAt: true,
      previewOpenMode: true,
    },
  });

  if (!session) {
    return NextResponse.json(
      { error: "Preview session not found" },
      { status: 404 },
    );
  }

  if (
    session.threadId !== exchangeClaims.threadId ||
    session.threadChatId !== exchangeClaims.threadChatId ||
    session.runId !== exchangeClaims.runId ||
    session.userId !== exchangeClaims.userId ||
    session.codesandboxId !== exchangeClaims.codesandboxId ||
    session.sandboxProvider !== exchangeClaims.sandboxProvider
  ) {
    return NextResponse.json(
      {
        code: "binding_mismatch",
        error: "Preview session claims do not match",
      },
      { status: 403 },
    );
  }

  if (
    session.revokedAt ||
    (session.expiresAt && session.expiresAt.getTime() <= Date.now())
  ) {
    return NextResponse.json(
      {
        code: "expired",
        error: "Preview session is no longer active",
      },
      { status: 401 },
    );
  }

  const openMode = bodyResult.data.openMode ?? session.previewOpenMode;
  const cookieToken = await mintPreviewCookieToken({
    claims: {
      previewSessionId: session.previewSessionId,
      threadId: session.threadId,
      threadChatId: session.threadChatId,
      runId: session.runId,
      userId: session.userId ?? exchangeClaims.userId,
      codesandboxId: session.codesandboxId,
      sandboxProvider: session.sandboxProvider,
      revocationVersion: session.revocationVersion,
    },
    jti: crypto.randomUUID(),
  });

  const broadcastToken = await mintPreviewBroadcastToken({
    claims: {
      previewSessionId: session.previewSessionId,
      threadId: session.threadId,
      threadChatId: session.threadChatId,
      runId: session.runId,
      userId: session.userId ?? exchangeClaims.userId,
      codesandboxId: session.codesandboxId,
      sandboxProvider: session.sandboxProvider,
      schemaVersion: previewBroadcastSchemaVersion,
      channelType: "preview",
    },
    jti: crypto.randomUUID(),
  });

  const channel = getBroadcastChannelStr({
    type: "preview",
    previewSessionId: session.previewSessionId,
    threadId: session.threadId,
    threadChatId: session.threadChatId,
    runId: session.runId,
    userId: session.userId ?? exchangeClaims.userId,
    schemaVersion: previewBroadcastSchemaVersion,
  });

  const response = NextResponse.json({
    message: "ok",
    previewSessionId: session.previewSessionId,
    state: session.state,
    openMode,
    channel,
    broadcastToken,
    proxyBasePath: `/api/preview/proxy/${session.previewSessionId}`,
  });

  response.cookies.set(
    getPreviewCookieName(session.previewSessionId),
    cookieToken,
    {
      httpOnly: true,
      secure: true,
      path: "/api/preview",
      sameSite: openMode === "iframe" ? "none" : "lax",
      maxAge: previewSessionTTLSeconds,
    },
  );

  if (openMode !== session.previewOpenMode) {
    await db
      .update(previewSession)
      .set({
        previewOpenMode: openMode,
      })
      .where(eq(previewSession.previewSessionId, session.previewSessionId));
  }

  return response;
}
