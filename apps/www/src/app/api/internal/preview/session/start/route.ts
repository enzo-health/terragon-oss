import { getUserIdOrNull } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  enforcePreviewRateLimit,
  PreviewRateLimitError,
} from "@/lib/rate-limit";
import {
  getClientIpFromRequest,
  mintPreviewUpstreamOriginToken,
  mintPreviewExchangeToken,
  resolvePinnedUpstreamIpsFromOrigin,
} from "@/server-lib/preview-auth";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  previewSessionTTLSeconds,
  type PreviewOpenMode,
  type PreviewUnsupportedReason,
} from "@terragon/shared/types/preview";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import {
  previewSession,
  threadChat,
  threadRun,
  threadRunContext,
} from "@terragon/shared/db/schema";
import { getThreadMinimal } from "@terragon/shared/model/threads";
import { z } from "zod/v4";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const startPreviewBodySchema = z.object({
  threadId: z.string().min(1),
  threadChatId: z.string().min(1),
  runId: z.string().min(1).optional(),
  openMode: z.enum(["iframe", "new_tab"]).optional(),
});

export async function POST(request: Request) {
  const userId = await getUserIdOrNull();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const isPreviewEnabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "sandboxPreview",
  });
  if (!isPreviewEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parseResult = startPreviewBodySchema.safeParse(await request.json());
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: "Invalid request body",
        issues: parseResult.error.issues,
      },
      { status: 400 },
    );
  }

  const body = parseResult.data;
  const { ip } = getClientIpFromRequest(request);

  try {
    await enforcePreviewRateLimit({
      scope: "start",
      userId,
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

  const [thread, matchingThreadChat, runContext] = await Promise.all([
    getThreadMinimal({
      db,
      userId,
      threadId: body.threadId,
    }),
    db.query.threadChat.findFirst({
      where: and(
        eq(threadChat.id, body.threadChatId),
        eq(threadChat.threadId, body.threadId),
        eq(threadChat.userId, userId),
      ),
      columns: {
        id: true,
      },
    }),
    db.query.threadRunContext.findFirst({
      where: and(
        eq(threadRunContext.threadId, body.threadId),
        eq(threadRunContext.threadChatId, body.threadChatId),
      ),
      columns: {
        activeRunId: true,
      },
    }),
  ]);

  if (!thread || !matchingThreadChat) {
    return NextResponse.json({ error: "Thread not found" }, { status: 404 });
  }

  const runId = body.runId ?? runContext?.activeRunId;
  if (!runId || !runContext || runContext.activeRunId !== runId) {
    return NextResponse.json(
      {
        error: "Run is not active for this thread chat",
      },
      { status: 409 },
    );
  }

  const run = await db.query.threadRun.findFirst({
    where: and(
      eq(threadRun.runId, runId),
      eq(threadRun.threadId, body.threadId),
      eq(threadRun.threadChatId, body.threadChatId),
    ),
    columns: {
      runId: true,
      codesandboxId: true,
      sandboxProvider: true,
    },
  });

  if (!run) {
    return NextResponse.json(
      {
        error: "Run context was not found",
      },
      { status: 409 },
    );
  }

  if (!run.codesandboxId || !run.sandboxProvider) {
    return NextResponse.json(
      {
        error: "Run sandbox is not bound yet",
      },
      { status: 409 },
    );
  }

  const openMode: PreviewOpenMode = body.openMode ?? "iframe";
  const now = new Date();
  const expiresAt = new Date(now.getTime() + previewSessionTTLSeconds * 1000);
  const previewRequiresWebsocket = false;

  const [createdSession] = await db
    .insert(previewSession)
    .values({
      threadId: body.threadId,
      threadChatId: body.threadChatId,
      runId,
      userId,
      codesandboxId: run.codesandboxId,
      sandboxProvider: run.sandboxProvider,
      repoFullName: thread.githubRepoFullName,
      previewRequiresWebsocket,
      previewOpenMode: openMode,
      state: "pending",
      expiresAt,
    })
    .returning({
      previewSessionId: previewSession.previewSessionId,
      previewOpenMode: previewSession.previewOpenMode,
    });

  if (!createdSession) {
    return NextResponse.json(
      {
        error: "Unable to create preview session",
      },
      { status: 500 },
    );
  }

  const previewSessionId = createdSession.previewSessionId;

  await db
    .update(previewSession)
    .set({
      state: "initializing",
    })
    .where(eq(previewSession.previewSessionId, previewSessionId));

  try {
    const unsupportedReason: PreviewUnsupportedReason =
      run.sandboxProvider === "daytona"
        ? "capability_missing"
        : "adapter_unimplemented";

    const previewOrigin = new URL(
      `https://${run.codesandboxId}.preview.terragon.local`,
    );
    const pinningMode = "tls_sni_host" as const;
    const pinnedUpstreamIps = await resolvePinnedUpstreamIpsFromOrigin(
      previewOrigin,
      pinningMode,
    );

    const upstreamOriginToken = await mintPreviewUpstreamOriginToken({
      claims: {
        scheme: previewOrigin.protocol === "https:" ? "https" : "http",
        host: previewOrigin.hostname,
        port: Number(
          previewOrigin.port ||
            (previewOrigin.protocol === "https:" ? 443 : 80),
        ),
        pinningMode,
        exp: Math.floor(expiresAt.getTime() / 1000),
        previewSessionId,
        revocationVersion: 1,
      },
      jti: crypto.randomUUID(),
    });

    await db
      .update(previewSession)
      .set({
        state: "unsupported",
        unsupportedReason,
        previewRequiresWebsocket,
        upstreamOrigin: previewOrigin.origin,
        upstreamOriginToken,
        pinnedUpstreamIpsJson: pinnedUpstreamIps,
        revocationVersion: 1,
        expiresAt,
      })
      .where(eq(previewSession.previewSessionId, previewSessionId));

    const exchangeToken = await mintPreviewExchangeToken({
      claims: {
        previewSessionId,
        threadId: body.threadId,
        threadChatId: body.threadChatId,
        runId,
        userId,
        codesandboxId: run.codesandboxId,
        sandboxProvider: run.sandboxProvider,
      },
      nonce: crypto.randomUUID(),
      jti: crypto.randomUUID(),
    });

    return NextResponse.json({
      previewSessionId,
      state: "unsupported",
      unsupportedReason,
      openMode,
      expiresAt: expiresAt.toISOString(),
      exchangeToken,
    });
  } catch (error) {
    await db
      .update(previewSession)
      .set({
        state: "error",
      })
      .where(eq(previewSession.previewSessionId, previewSessionId));

    console.error("Failed to initialize preview session", {
      previewSessionId,
      threadId: body.threadId,
      threadChatId: body.threadChatId,
      runId,
      error,
    });

    return NextResponse.json(
      {
        code: "proxy_denied",
        error: "Preview initialization failed",
      },
      { status: 502 },
    );
  }
}
