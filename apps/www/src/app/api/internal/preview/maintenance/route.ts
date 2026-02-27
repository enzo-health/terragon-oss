import { db } from "@/lib/db";
import {
  authenticatePreviewMaintenanceRequest,
  PreviewMaintenanceAuthError,
} from "@/server-lib/preview-validation";
import {
  daemonEventQuarantine,
  threadRun,
  threadRunContext,
  threadUiValidation,
} from "@terragon/shared/db/schema";
import { getFeatureFlagsGlobal } from "@terragon/shared/model/feature-flags";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { getPostHogServer } from "@/lib/posthog-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maintenanceBodySchema = z.object({
  staleMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const ACTIVE_RUN_STATUSES = ["booting", "running", "validating"] as const;

export async function POST(request: Request) {
  const rawBody = await request.text();
  try {
    await authenticatePreviewMaintenanceRequest({
      request,
      body: rawBody,
    });
  } catch (error) {
    if (error instanceof PreviewMaintenanceAuthError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const featureFlags = await getFeatureFlagsGlobal({ db });
  if (!featureFlags.sandboxPreview) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let bodyInput: unknown = {};
  if (rawBody.length > 0) {
    try {
      bodyInput = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 },
      );
    }
  }
  const parsedBody = maintenanceBodySchema.safeParse(bodyInput);
  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parsedBody.error.issues },
      { status: 400 },
    );
  }

  const staleMinutes = parsedBody.data.staleMinutes ?? 15;
  const limit = parsedBody.data.limit ?? 100;
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
  const now = new Date();
  const quarantineCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const staleRuns = await db.query.threadRun.findMany({
    where: and(
      inArray(threadRun.status, ACTIVE_RUN_STATUSES),
      isNull(threadRun.endedAt),
      isNull(threadRun.runEndSha),
      lt(threadRun.startedAt, cutoff),
    ),
    columns: {
      runId: true,
      threadId: true,
      threadChatId: true,
    },
    limit,
    orderBy: [threadRun.startedAt],
  });

  for (const staleRun of staleRuns) {
    await db.transaction(async (tx) => {
      await tx
        .update(threadRun)
        .set({
          status: "failed",
          endedAt: now,
        })
        .where(eq(threadRun.runId, staleRun.runId));

      await tx
        .update(threadRunContext)
        .set({
          activeStatus: "failed",
          activeUpdatedAt: now,
        })
        .where(
          and(
            eq(threadRunContext.threadId, staleRun.threadId),
            eq(threadRunContext.threadChatId, staleRun.threadChatId),
            eq(threadRunContext.activeRunId, staleRun.runId),
          ),
        );

      await tx
        .insert(threadUiValidation)
        .values({
          threadId: staleRun.threadId,
          threadChatId: staleRun.threadChatId,
          latestRunId: staleRun.runId,
          uiValidationOutcome: "blocked",
          readyDowngradeState: "not_attempted",
          blockingReason:
            "Run finalized by maintenance because terminal endSha was missing.",
        })
        .onConflictDoNothing();

      await tx
        .update(threadUiValidation)
        .set({
          latestRunId: staleRun.runId,
          uiValidationOutcome: "blocked",
          blockingReason:
            "Run finalized by maintenance because terminal endSha was missing.",
        })
        .where(
          and(
            eq(threadUiValidation.threadId, staleRun.threadId),
            eq(threadUiValidation.threadChatId, staleRun.threadChatId),
          ),
        );
    });
  }

  const [quarantineCountRow] = await db
    .select({
      count: sql<number>`count(*)`,
    })
    .from(daemonEventQuarantine)
    .where(lt(daemonEventQuarantine.createdAt, quarantineCutoff));
  const purgedQuarantineRows = Number(quarantineCountRow?.count ?? 0);

  if (purgedQuarantineRows > 0) {
    getPostHogServer().capture({
      distinctId: "preview-system",
      event: "preview.quarantine.purge",
      properties: {
        schemaVersion: 1,
        origin: "preview_maintenance",
        tsServer: new Date().toISOString(),
        traceId: crypto.randomUUID(),
        purgedQuarantineRows,
      },
    });
    await db
      .delete(daemonEventQuarantine)
      .where(lt(daemonEventQuarantine.createdAt, quarantineCutoff));
  }

  return NextResponse.json({
    staleMinutes,
    processed: staleRuns.length,
    cutoff: cutoff.toISOString(),
    purgedQuarantineRows,
  });
}
