/**
 * Babysit recheck: self-healing for missed GitHub webhooks.
 *
 * When a delivery loop is stuck in "babysitting" because we never received
 * a check_suite.completed webhook (e.g., ngrok was down), this module polls
 * GitHub directly for the CI status and inserts a synthetic signal so the
 * existing signal-inbox machinery can evaluate babysit completion.
 *
 * Two trigger points:
 * 1. UI page load — getDeliveryLoopStatusAction fires a background recheck
 * 2. Self-scheduling — after a babysit eval that doesn't pass, a recheck
 *    signal is inserted so the 1-min scheduled-tasks drain picks it up
 */
import type { DB } from "@terragon/shared/db";
import * as schema from "@terragon/shared/db/schema";
import { SDLC_CAUSE_IDENTITY_VERSION } from "@terragon/shared/model/delivery-loop";
import { getOctokitForApp, parseRepoFullName } from "@/lib/github";
import { redis } from "@/lib/redis";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

const BABYSIT_RECHECK_COOLDOWN_SECONDS = 120; // 2 min between rechecks per loop

type BabysitRecheckResult =
  | { action: "skipped"; reason: string }
  | { action: "signal_inserted"; signalId: string }
  | { action: "no_signal_needed"; reason: string };

/**
 * Poll GitHub CI for a babysitting loop and insert a synthetic
 * check_suite.completed signal if all checks have completed.
 *
 * Rate-limited to once per 2 minutes per loop via Redis.
 */
export async function recheckBabysitCompletion({
  db,
  loopId,
}: {
  db: DB;
  loopId: string;
}): Promise<BabysitRecheckResult> {
  // Rate-limit: skip if we already checked recently
  const cooldownKey = `babysit-recheck:${loopId}`;
  const alreadyChecked = await redis.set(cooldownKey, "1", {
    nx: true,
    ex: BABYSIT_RECHECK_COOLDOWN_SECONDS,
  });
  if (alreadyChecked !== "OK") {
    return { action: "skipped", reason: "cooldown" };
  }

  // Load the loop
  const loop = await db.query.sdlcLoop.findFirst({
    where: eq(schema.sdlcLoop.id, loopId),
    columns: {
      id: true,
      state: true,
      repoFullName: true,
      prNumber: true,
      currentHeadSha: true,
    },
  });

  if (!loop) {
    return { action: "skipped", reason: "loop_not_found" };
  }
  if (loop.state !== "babysitting") {
    return { action: "skipped", reason: `state_is_${loop.state}` };
  }
  if (!loop.currentHeadSha || !loop.repoFullName) {
    return { action: "skipped", reason: "missing_head_sha_or_repo" };
  }

  // Poll GitHub for current CI status
  const ciSnapshot = await fetchCiSnapshotForHead({
    repoFullName: loop.repoFullName,
    headSha: loop.currentHeadSha,
  });

  if (!ciSnapshot) {
    return { action: "no_signal_needed", reason: "github_poll_failed" };
  }

  if (!ciSnapshot.complete) {
    return { action: "no_signal_needed", reason: "checks_still_running" };
  }

  // All checks completed — insert a synthetic check_suite.completed signal
  const syntheticDeliveryId = `babysit-recheck:${randomUUID()}`;
  const syntheticSuiteId = `babysit-recheck:${loop.currentHeadSha}:${Date.now()}`;
  const checkOutcome = ciSnapshot.failingChecks.length > 0 ? "fail" : "pass";

  const inserted = await db
    .insert(schema.sdlcLoopSignalInbox)
    .values({
      loopId: loop.id,
      causeType: "check_suite.completed",
      canonicalCauseId: `${syntheticDeliveryId}:${syntheticSuiteId}`,
      signalHeadShaOrNull: null,
      causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      payload: {
        eventType: "check_suite.completed",
        repoFullName: loop.repoFullName,
        prNumber: loop.prNumber,
        checkSuiteId: syntheticSuiteId,
        checkOutcome,
        headSha: loop.currentHeadSha,
        ciSnapshotSource: "babysit_recheck",
        ciSnapshotCheckNames: ciSnapshot.checkNames,
        ciSnapshotFailingChecks: ciSnapshot.failingChecks,
        ciSnapshotComplete: true,
        sourceType: "automation",
      },
    })
    .onConflictDoNothing()
    .returning({ id: schema.sdlcLoopSignalInbox.id });

  if (inserted.length === 0) {
    return { action: "no_signal_needed", reason: "signal_deduplicated" };
  }

  return { action: "signal_inserted", signalId: inserted[0]!.id };
}

// ---------------------------------------------------------------------------
// GitHub CI polling (extracted from handlers.ts for reuse)
// ---------------------------------------------------------------------------

type CiSnapshot = {
  checkNames: string[];
  failingChecks: string[];
  complete: boolean;
};

function isActionableCheckFailure(conclusion: string | null): boolean {
  if (!conclusion) return false;
  return [
    "failure",
    "timed_out",
    "cancelled",
    "action_required",
    "startup_failure",
    "stale",
  ].includes(conclusion);
}

async function fetchCiSnapshotForHead({
  repoFullName,
  headSha,
}: {
  repoFullName: string;
  headSha: string;
}): Promise<CiSnapshot | null> {
  try {
    const [owner, repo] = parseRepoFullName(repoFullName);
    const octokit = (await getOctokitForApp({
      owner,
      repo,
    })) as Awaited<ReturnType<typeof getOctokitForApp>> | null | undefined;
    if (!octokit) return null;

    const response = await octokit.rest.checks.listForRef({
      owner,
      repo,
      ref: headSha,
      per_page: 100,
    });

    const checkRuns = response.data.check_runs;
    if (checkRuns.length === 0) return null;

    const checkNames = Array.from(
      new Set(
        checkRuns
          .map((run) => run.name?.trim() ?? "")
          .filter((name) => name.length > 0),
      ),
    ).sort();

    const failingChecks = Array.from(
      new Set(
        checkRuns
          .filter((run) => isActionableCheckFailure(run.conclusion ?? null))
          .map((run) => run.name?.trim() ?? "")
          .filter((name) => name.length > 0),
      ),
    ).sort();

    const complete = checkRuns.every((run) => run.status === "completed");

    return { checkNames, failingChecks, complete };
  } catch (error) {
    console.warn("[babysit-recheck] failed to poll GitHub CI", {
      repoFullName,
      headSha,
      error,
    });
    return null;
  }
}
