/**
 * Babysit recheck: self-healing for missed GitHub webhooks.
 *
 * When a delivery loop is stuck in "babysitting" because we never received
 * a check_suite.completed or pull_request_review webhook (e.g., ngrok was
 * down), this module polls GitHub directly for CI status and review thread
 * state, then inserts synthetic signals so the existing signal-inbox
 * machinery can evaluate babysit completion.
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
import { fetchUnresolvedReviewThreadCount } from "@/app/api/webhooks/github/handlers";
import { redis } from "@/lib/redis";
import { eq } from "drizzle-orm";

const BABYSIT_RECHECK_COOLDOWN_SECONDS = 120; // 2 min between rechecks per loop

type BabysitRecheckResult =
  | { action: "skipped"; reason: string }
  | { action: "signal_inserted"; signalId: string }
  | { action: "signals_inserted"; signalIds: string[] }
  | { action: "no_signal_needed"; reason: string };

/**
 * Poll GitHub CI and review threads for a babysitting loop and insert
 * synthetic signals if checks have completed or review state is available.
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

  // Poll GitHub for CI status and review threads in parallel
  const [ciSnapshot, unresolvedThreadCount] = await Promise.all([
    fetchCiSnapshotForHead({
      repoFullName: loop.repoFullName,
      headSha: loop.currentHeadSha,
    }),
    loop.prNumber
      ? fetchUnresolvedReviewThreadCount({
          repoFullName: loop.repoFullName,
          prNumber: loop.prNumber,
        })
      : Promise.resolve(null),
  ]);

  console.log("[babysit-recheck] poll results", {
    loopId,
    headSha: loop.currentHeadSha,
    prNumber: loop.prNumber,
    ci: ciSnapshot
      ? {
          complete: ciSnapshot.complete,
          checkCount: ciSnapshot.checkNames.length,
          failingCount: ciSnapshot.failingChecks.length,
        }
      : null,
    unresolvedThreadCount,
  });

  const insertedSignalIds: string[] = [];

  // Insert CI signal if checks completed or have failing results
  const hasFailing = (ciSnapshot?.failingChecks.length ?? 0) > 0;
  if (ciSnapshot && (ciSnapshot.complete || hasFailing)) {
    const checkOutcome = ciSnapshot.failingChecks.length > 0 ? "fail" : "pass";
    const deterministicSuiteId = ciSnapshot.complete
      ? `babysit-recheck:ci:${loop.id}:${loop.currentHeadSha}`
      : `babysit-recheck:ci:partial:${loop.id}:${loop.currentHeadSha}`;

    const inserted = await db
      .insert(schema.sdlcLoopSignalInbox)
      .values({
        loopId: loop.id,
        causeType: "check_suite.completed",
        canonicalCauseId: deterministicSuiteId,
        signalHeadShaOrNull: loop.currentHeadSha,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
        payload: {
          eventType: "check_suite.completed",
          repoFullName: loop.repoFullName,
          prNumber: loop.prNumber,
          checkSuiteId: deterministicSuiteId,
          checkOutcome,
          headSha: loop.currentHeadSha,
          // Use "github_check_runs" since we poll via checks.listForRef —
          // the gate evaluator only trusts this source for optimistic passes.
          // For partial snapshots (incomplete but failing), omit snapshot fields
          // so the signal takes the per-check failure path instead of overwriting
          // the required-check baseline.
          ...(ciSnapshot.complete
            ? {
                ciSnapshotSource: "github_check_runs" as const,
                ciSnapshotCheckNames: ciSnapshot.checkNames,
                ciSnapshotFailingChecks: ciSnapshot.failingChecks,
                ciSnapshotComplete: true,
              }
            : {}),
          sourceType: "automation",
        },
      })
      .onConflictDoNothing()
      .returning({ id: schema.sdlcLoopSignalInbox.id });

    if (inserted.length > 0) {
      insertedSignalIds.push(inserted[0]!.id);
    }
  }

  // Insert review signal if we got a thread count
  if (unresolvedThreadCount !== null) {
    const deterministicReviewId = `babysit-recheck:review:${loop.id}:${loop.currentHeadSha}`;

    const inserted = await db
      .insert(schema.sdlcLoopSignalInbox)
      .values({
        loopId: loop.id,
        causeType: "pull_request_review",
        canonicalCauseId: deterministicReviewId,
        signalHeadShaOrNull: loop.currentHeadSha,
        causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
        payload: {
          eventType: "pull_request_review.submitted",
          repoFullName: loop.repoFullName,
          prNumber: loop.prNumber,
          reviewId: deterministicReviewId,
          reviewState: "synthetic_poll",
          unresolvedThreadCount,
          unresolvedThreadCountSource: "github_graphql",
          headSha: loop.currentHeadSha,
          reviewBody: null,
          sourceType: "automation",
        },
      })
      .onConflictDoNothing()
      .returning({ id: schema.sdlcLoopSignalInbox.id });

    if (inserted.length > 0) {
      insertedSignalIds.push(inserted[0]!.id);
    }
  }

  if (insertedSignalIds.length === 0) {
    const reasons: string[] = [];
    if (!ciSnapshot) reasons.push("github_ci_poll_failed");
    else if (!ciSnapshot.complete) reasons.push("checks_running_no_failures");
    else reasons.push("ci_signal_deduplicated");
    if (!loop.prNumber) reasons.push("no_pr_number");
    else if (unresolvedThreadCount === null) reasons.push("review_poll_failed");
    else reasons.push("review_signal_deduplicated");
    const result: BabysitRecheckResult = {
      action: "no_signal_needed",
      reason: reasons.join("+"),
    };
    console.log("[babysit-recheck] result", { loopId, ...result });
    return result;
  }

  if (insertedSignalIds.length === 1) {
    const result: BabysitRecheckResult = {
      action: "signal_inserted",
      signalId: insertedSignalIds[0]!,
    };
    console.log("[babysit-recheck] result", { loopId, ...result });
    return result;
  }

  const result: BabysitRecheckResult = {
    action: "signals_inserted",
    signalIds: insertedSignalIds,
  };
  console.log("[babysit-recheck] result", { loopId, ...result });
  return result;
}

/**
 * Poll GitHub CI for a loop stuck in ci_gate and insert a synthetic signal
 * if checks have completed or have failing results.
 *
 * This mirrors recheckBabysitCompletion but for the ci_gate phase.
 */
export async function recheckCiGateCompletion({
  db,
  loopId,
}: {
  db: DB;
  loopId: string;
}): Promise<BabysitRecheckResult> {
  const cooldownKey = `ci-gate-recheck:${loopId}`;
  const alreadyChecked = await redis.set(cooldownKey, "1", {
    nx: true,
    ex: BABYSIT_RECHECK_COOLDOWN_SECONDS,
  });
  if (alreadyChecked !== "OK") {
    return { action: "skipped", reason: "cooldown" };
  }

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
  if (loop.state !== "ci_gate") {
    return { action: "skipped", reason: `state_is_${loop.state}` };
  }
  if (!loop.currentHeadSha || !loop.repoFullName) {
    return { action: "skipped", reason: "missing_head_sha_or_repo" };
  }

  const ciSnapshot = await fetchCiSnapshotForHead({
    repoFullName: loop.repoFullName,
    headSha: loop.currentHeadSha,
  });

  console.log("[ci-gate-recheck] poll results", {
    loopId,
    headSha: loop.currentHeadSha,
    ci: ciSnapshot
      ? {
          complete: ciSnapshot.complete,
          checkCount: ciSnapshot.checkNames.length,
          failingCount: ciSnapshot.failingChecks.length,
        }
      : null,
  });

  const hasFailing = (ciSnapshot?.failingChecks.length ?? 0) > 0;
  if (!ciSnapshot || (!ciSnapshot.complete && !hasFailing)) {
    const reason = !ciSnapshot
      ? "github_ci_poll_failed"
      : "checks_running_no_failures";
    console.log("[ci-gate-recheck] result", {
      loopId,
      action: "no_signal_needed",
      reason,
    });
    return { action: "no_signal_needed", reason };
  }

  const checkOutcome = ciSnapshot.failingChecks.length > 0 ? "fail" : "pass";
  const deterministicSuiteId = ciSnapshot.complete
    ? `ci-gate-recheck:ci:${loop.id}:${loop.currentHeadSha}`
    : `ci-gate-recheck:ci:partial:${loop.id}:${loop.currentHeadSha}`;

  const inserted = await db
    .insert(schema.sdlcLoopSignalInbox)
    .values({
      loopId: loop.id,
      causeType: "check_suite.completed",
      canonicalCauseId: deterministicSuiteId,
      signalHeadShaOrNull: loop.currentHeadSha,
      causeIdentityVersion: SDLC_CAUSE_IDENTITY_VERSION,
      payload: {
        eventType: "check_suite.completed",
        repoFullName: loop.repoFullName,
        prNumber: loop.prNumber,
        checkSuiteId: deterministicSuiteId,
        checkOutcome,
        headSha: loop.currentHeadSha,
        // Use "github_check_runs" since we poll via checks.listForRef —
        // the gate evaluator only trusts this source for optimistic passes.
        // For partial snapshots, omit snapshot fields so the signal takes
        // the per-check failure path without overwriting the baseline.
        ...(ciSnapshot.complete
          ? {
              ciSnapshotSource: "github_check_runs" as const,
              ciSnapshotCheckNames: ciSnapshot.checkNames,
              ciSnapshotFailingChecks: ciSnapshot.failingChecks,
              ciSnapshotComplete: true,
            }
          : {}),
        sourceType: "automation",
      },
    })
    .onConflictDoNothing()
    .returning({ id: schema.sdlcLoopSignalInbox.id });

  if (inserted.length > 0) {
    const result: BabysitRecheckResult = {
      action: "signal_inserted",
      signalId: inserted[0]!.id,
    };
    console.log("[ci-gate-recheck] result", { loopId, ...result });
    return result;
  }

  const result: BabysitRecheckResult = {
    action: "no_signal_needed",
    reason: "ci_signal_deduplicated",
  };
  console.log("[ci-gate-recheck] result", { loopId, ...result });
  return result;
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
