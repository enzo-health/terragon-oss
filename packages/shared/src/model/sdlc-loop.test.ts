import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db";
import { env } from "@terragon/env/pkg-shared";
import * as schema from "../db/schema";
import { and, eq } from "drizzle-orm";
import { createTestThread, createTestUser } from "./test-helpers";
import {
  acquireSdlcLoopLease,
  buildSdlcCanonicalCause,
  canRunCarmackReviewForHeadSha,
  claimGithubWebhookDelivery,
  completeGithubWebhookDelivery,
  evaluateSdlcLoopGuardrails,
  enrollSdlcLoopForGithubPR,
  enqueueSdlcOutboxAction,
  evaluateSdlcParitySlo,
  getActiveSdlcLoopForThread,
  getSdlcParityBucketStats,
  getSdlcOutboxSupersessionGroup,
  getUnresolvedBlockingCarmackReviewFindings,
  getActiveSdlcLoopForGithubPRAndUser,
  getActiveSdlcLoopForGithubPR,
  claimNextSdlcOutboxActionForExecution,
  classifySdlcVideoCaptureFailure,
  clearSdlcCanonicalStatusCommentReference,
  completeSdlcOutboxActionExecution,
  persistCarmackReviewGateResult,
  persistSdlcCanonicalCheckRunReference,
  persistSdlcCanonicalStatusCommentReference,
  persistSdlcCiGateEvaluation,
  persistSdlcVideoCaptureOutcome,
  recordSdlcParityMetricSample,
  persistDeepReviewGateResult,
  persistSdlcReviewThreadGateEvaluation,
  releaseGithubWebhookDeliveryClaim,
  releaseSdlcLoopLease,
  resolveCarmackReviewFinding,
  getUnresolvedBlockingDeepReviewFindings,
  resolveDeepReviewFinding,
  shouldQueueFollowUpForCarmackReview,
  shouldQueueFollowUpForDeepReview,
  transitionLoopToStoppedAndCancelPendingOutbox,
} from "./sdlc-loop";

const db = createDb(env.DATABASE_URL!);

describe("sdlc loop model", () => {
  beforeEach(async () => {
    await db.delete(schema.sdlcCarmackReviewFinding);
    await db.delete(schema.sdlcCarmackReviewRun);
    await db.delete(schema.sdlcReviewThreadGateRun);
    await db.delete(schema.sdlcCiGateRun);
    await db.delete(schema.sdlcDeepReviewFinding);
    await db.delete(schema.sdlcDeepReviewRun);
    await db.delete(schema.sdlcParityMetricSample);
    await db.delete(schema.sdlcLoopOutboxAttempt);
    await db.delete(schema.sdlcLoopOutbox);
    await db.delete(schema.sdlcLoopSignalInbox);
    await db.delete(schema.sdlcLoopLease);
    await db.delete(schema.githubWebhookDeliveries);
    await db.delete(schema.sdlcLoop);
  });

  it("returns active enrollment for repo/pr/user", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
      currentHeadSha: "abc123",
    });

    const loop = await getActiveSdlcLoopForGithubPRAndUser({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
    });

    expect(loop).not.toBeNull();
    expect(loop?.threadId).toBe(threadId);
    expect(loop?.currentHeadSha).toBe("abc123");
  });

  it("returns active enrollment for repo/pr without user hint", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
      currentHeadSha: "sha-lookup",
    });

    const byRepoPr = await getActiveSdlcLoopForGithubPR({
      db,
      repoFullName: "owner/repo",
      prNumber: 42,
    });

    expect(byRepoPr?.id).toBe(loop?.id);
    expect(byRepoPr?.currentHeadSha).toBe("sha-lookup");
  });

  it("ignores non-active states", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const enrolled = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({ state: "stopped" })
      .where(eq(schema.sdlcLoop.id, enrolled!.id));

    const loop = await getActiveSdlcLoopForGithubPRAndUser({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
    });

    expect(loop).toBeUndefined();
  });

  it("reuses existing enrollment on conflict", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const first = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    const second = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    expect(second?.id).toBe(first?.id);
  });

  it("allows re-enrollment after terminal PR-closed state", async () => {
    const { user } = await createTestUser({ db });
    const { threadId: firstThreadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });
    const { threadId: secondThreadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const first = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId: firstThreadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({ state: "terminated_pr_closed" })
      .where(eq(schema.sdlcLoop.id, first!.id));

    const second = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId: secondThreadId,
    });

    expect(second).toBeDefined();
    expect(second?.id).not.toBe(first?.id);
    expect(second?.state).toBe("enrolled");
  });

  it("returns active enrollment by thread", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    const loop = await getActiveSdlcLoopForThread({
      db,
      userId: user.id,
      threadId,
    });

    expect(loop?.threadId).toBe(threadId);
  });

  it("builds canonical cause IDs with delivery uniqueness for non-daemon causes", () => {
    const checkRunCause = buildSdlcCanonicalCause({
      causeType: "check_run.completed",
      deliveryId: "delivery-1",
      checkRunId: 777,
    });

    expect(checkRunCause).toEqual({
      causeType: "check_run.completed",
      canonicalCauseId: "delivery-1:777",
      signalHeadShaOrNull: null,
      causeIdentityVersion: 1,
    });

    const daemonCause = buildSdlcCanonicalCause({
      causeType: "daemon_terminal",
      eventId: "evt-abc",
    });

    expect(daemonCause.canonicalCauseId).toBe("evt-abc");
  });

  it("returns canonical supersession group for each outbox action", () => {
    expect(getSdlcOutboxSupersessionGroup("publish_status_comment")).toBe(
      "publication_status",
    );
    expect(getSdlcOutboxSupersessionGroup("publish_check_summary")).toBe(
      "publication_status",
    );
    expect(getSdlcOutboxSupersessionGroup("enqueue_fix_task")).toBe(
      "fix_task_enqueue",
    );
    expect(getSdlcOutboxSupersessionGroup("publish_video_link")).toBe(
      "publication_video",
    );
    expect(getSdlcOutboxSupersessionGroup("emit_telemetry")).toBe("telemetry");
  });

  it("uses deterministic GitHub webhook delivery claim outcomes", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    const firstClaim = await claimGithubWebhookDelivery({
      db,
      deliveryId: "delivery-1",
      claimantToken: "claimer-1",
      eventType: "pull_request.opened",
      now,
    });
    expect(firstClaim).toEqual({
      outcome: "claimed_new",
      shouldProcess: true,
    });

    const concurrentClaim = await claimGithubWebhookDelivery({
      db,
      deliveryId: "delivery-1",
      claimantToken: "claimer-2",
      eventType: "pull_request.opened",
      now,
    });
    expect(concurrentClaim).toEqual({
      outcome: "in_progress_fresh",
      shouldProcess: false,
    });

    const completed = await completeGithubWebhookDelivery({
      db,
      deliveryId: "delivery-1",
      claimantToken: "claimer-1",
      completedAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    expect(completed).toBe(true);

    const completedClaim = await claimGithubWebhookDelivery({
      db,
      deliveryId: "delivery-1",
      claimantToken: "claimer-3",
      eventType: "pull_request.opened",
      now: new Date("2026-01-01T00:00:02.000Z"),
    });
    expect(completedClaim).toEqual({
      outcome: "already_completed",
      shouldProcess: false,
    });
  });

  it("steals stale GitHub webhook delivery claims", async () => {
    const staleCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const staleExpiresAt = new Date("2026-01-01T00:01:00.000Z");
    await db.insert(schema.githubWebhookDeliveries).values({
      deliveryId: "delivery-stale",
      claimantToken: "stale-claimer",
      claimExpiresAt: staleExpiresAt,
      eventType: "pull_request.opened",
      createdAt: staleCreatedAt,
      updatedAt: staleCreatedAt,
    });

    const stolenClaim = await claimGithubWebhookDelivery({
      db,
      deliveryId: "delivery-stale",
      claimantToken: "fresh-claimer",
      eventType: "pull_request.opened",
      now: new Date("2026-01-01T00:10:00.000Z"),
    });

    expect(stolenClaim).toEqual({
      outcome: "stale_stolen",
      shouldProcess: true,
    });
  });

  it("releases in-progress GitHub webhook claims for immediate retry", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    const firstClaim = await claimGithubWebhookDelivery({
      db,
      deliveryId: "delivery-release",
      claimantToken: "claimer-1",
      eventType: "pull_request.opened",
      now,
    });
    expect(firstClaim).toEqual({
      outcome: "claimed_new",
      shouldProcess: true,
    });

    const released = await releaseGithubWebhookDeliveryClaim({
      db,
      deliveryId: "delivery-release",
      claimantToken: "claimer-1",
      releasedAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    expect(released).toBe(true);

    const retryClaim = await claimGithubWebhookDelivery({
      db,
      deliveryId: "delivery-release",
      claimantToken: "claimer-2",
      eventType: "pull_request.opened",
      now: new Date("2026-01-01T00:00:01.001Z"),
    });
    expect(retryClaim).toEqual({
      outcome: "stale_stolen",
      shouldProcess: true,
    });
  });

  it("serializes loop lease ownership with deterministic steal semantics", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });
    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    const first = await acquireSdlcLoopLease({
      db,
      loopId: loop!.id,
      leaseOwner: "worker-a",
      leaseTtlMs: 60_000,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(first.acquired).toBe(true);

    const second = await acquireSdlcLoopLease({
      db,
      loopId: loop!.id,
      leaseOwner: "worker-b",
      leaseTtlMs: 60_000,
      now: new Date("2026-01-01T00:00:30.000Z"),
    });
    expect(second).toMatchObject({
      acquired: false,
      reason: "held_by_other",
      leaseOwner: "worker-a",
    });

    const stolen = await acquireSdlcLoopLease({
      db,
      loopId: loop!.id,
      leaseOwner: "worker-b",
      leaseTtlMs: 60_000,
      now: new Date("2026-01-01T00:02:00.000Z"),
    });
    expect(stolen).toMatchObject({
      acquired: true,
      leaseOwner: "worker-b",
    });

    const released = await releaseSdlcLoopLease({
      db,
      loopId: loop!.id,
      leaseOwner: "worker-b",
    });
    expect(released).toBe(true);
  });

  it("evaluates guardrails in deterministic precedence order", () => {
    const deniedByKillSwitch = evaluateSdlcLoopGuardrails({
      killSwitchEnabled: true,
      isTerminalState: false,
      hasValidLease: true,
      cooldownUntil: null,
      iterationCount: 0,
      maxIterations: null,
      manualIntentAllowed: true,
    });
    expect(deniedByKillSwitch).toEqual({
      allowed: false,
      reasonCode: "kill_switch",
    });

    const deniedByCooldown = evaluateSdlcLoopGuardrails({
      killSwitchEnabled: false,
      isTerminalState: false,
      hasValidLease: true,
      cooldownUntil: new Date("2099-01-01T00:00:00.000Z"),
      iterationCount: 0,
      maxIterations: null,
      manualIntentAllowed: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(deniedByCooldown).toEqual({
      allowed: false,
      reasonCode: "cooldown",
    });

    const deniedByMaxIterations = evaluateSdlcLoopGuardrails({
      killSwitchEnabled: false,
      isTerminalState: false,
      hasValidLease: true,
      cooldownUntil: null,
      iterationCount: 3,
      maxIterations: 3,
      manualIntentAllowed: true,
    });
    expect(deniedByMaxIterations).toEqual({
      allowed: false,
      reasonCode: "max_iterations",
    });
  });

  it("atomically stops loop and cancels pending outbox rows", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });
    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    await db.insert(schema.sdlcLoopOutbox).values([
      {
        loopId: loop!.id,
        transitionSeq: 1,
        actionType: "publish_status_comment",
        supersessionGroup: "publication_status",
        actionKey: "status-1",
        payload: { test: true },
        status: "pending",
      },
      {
        loopId: loop!.id,
        transitionSeq: 2,
        actionType: "publish_check_summary",
        supersessionGroup: "publication_status",
        actionKey: "summary-1",
        payload: { test: true },
        status: "running",
      },
    ]);

    const result = await transitionLoopToStoppedAndCancelPendingOutbox({
      db,
      loopId: loop!.id,
      stopReason: "max_iterations_reached",
    });

    expect(result.canceledOutboxCount).toBe(2);

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("stopped");
    expect(reloadedLoop?.stopReason).toBe("max_iterations_reached");

    const outboxRows = await db.query.sdlcLoopOutbox.findMany({
      where: eq(schema.sdlcLoopOutbox.loopId, loop!.id),
    });
    expect(outboxRows.every((row) => row.status === "canceled")).toBe(true);
    expect(
      outboxRows.every((row) => row.canceledReason === "canceled_due_to_stop"),
    ).toBe(true);
  });

  it("persists CI gate evaluation with deterministic required-check precedence", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });
    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
      currentHeadSha: "sha-ci-1",
    });

    const result = await persistSdlcCiGateEvaluation({
      db,
      loopId: loop!.id,
      headSha: "sha-ci-1",
      loopVersion: 2,
      triggerEventType: "check_run.completed",
      capabilityState: "supported",
      rulesetChecks: ["lint", "tests"],
      branchProtectionChecks: ["legacy-check"],
      failingChecks: ["tests"],
      provenance: { source: "unit-test" },
    });

    expect(result.status).toBe("blocked");
    expect(result.requiredCheckSource).toBe("ruleset");
    expect(result.requiredChecks).toEqual(["lint", "tests"]);
    expect(result.failingRequiredChecks).toEqual(["tests"]);

    const run = await db.query.sdlcCiGateRun.findFirst({
      where: eq(schema.sdlcCiGateRun.loopId, loop!.id),
    });
    expect(run?.actorType).toBe("installation_app");
    expect(run?.capabilityState).toBe("supported");

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("blocked_on_ci");
  });

  it("persists review-thread gate evaluation and blocks when unresolved threads remain", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });
    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
      currentHeadSha: "sha-review-1",
    });

    const blocked = await persistSdlcReviewThreadGateEvaluation({
      db,
      loopId: loop!.id,
      headSha: "sha-review-1",
      loopVersion: 3,
      triggerEventType: "pull_request_review.submitted",
      evaluationSource: "webhook",
      unresolvedThreadCount: 2,
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.gatePassed).toBe(false);

    const passed = await persistSdlcReviewThreadGateEvaluation({
      db,
      loopId: loop!.id,
      headSha: "sha-review-1",
      loopVersion: 4,
      triggerEventType: "review-thread-poll-synthetic",
      evaluationSource: "polling",
      unresolvedThreadCount: 0,
      timeoutMs: 1000,
    });

    expect(passed.status).toBe("passed");
    expect(passed.gatePassed).toBe(true);

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("gates_running");
  });

  it("stores deterministic invalid-output deep review state", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    const result = await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-1",
      loopVersion: 1,
      model: "gpt-test",
      rawOutput: { invalid: true },
    });

    const run = await db.query.sdlcDeepReviewRun.findFirst({
      where: eq(schema.sdlcDeepReviewRun.id, result.runId),
    });
    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });

    expect(run?.status).toBe("invalid_output");
    expect(result.errorCode).toBe("deep_review_invalid_output");
    expect(reloadedLoop?.state).toBe("blocked_on_agent_fixes");
  });

  it("persists blocking findings with stable identifiers", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    const result = await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-2",
      loopVersion: 2,
      model: "gpt-test",
      rawOutput: {
        gatePassed: false,
        blockingFindings: [
          {
            stableFindingId: "custom-1",
            title: "Missing null guard",
            severity: "high",
            category: "runtime-safety",
            detail: "Access path may throw when value is null",
            suggestedFix: "Add optional chaining",
            isBlocking: true,
          },
          {
            title: "Inconsistent branch check",
            severity: "medium",
            category: "logic",
            detail: "Branch policy check does not handle detached head",
            suggestedFix: null,
            isBlocking: true,
          },
        ],
      },
    });

    const findings = await getUnresolvedBlockingDeepReviewFindings({
      db,
      loopId: loop!.id,
      headSha: "sha-2",
    });

    expect(result.status).toBe("blocked");
    expect(findings).toHaveLength(2);
    expect(
      findings.some((finding) => finding.stableFindingId === "custom-1"),
    ).toBe(true);
    expect(
      findings.some((finding) =>
        finding.stableFindingId.startsWith("deep_review_"),
      ),
    ).toBe(true);
  });

  it("is replay-safe and idempotent on same head sha", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    const payload = {
      gatePassed: false,
      blockingFindings: [
        {
          stableFindingId: "stable-1",
          title: "Unhandled promise",
          severity: "high",
          category: "async",
          detail: "Promise rejection path has no catch",
          suggestedFix: "Wrap with try/catch",
          isBlocking: true,
        },
      ],
    };

    await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-3",
      loopVersion: 3,
      model: "gpt-test",
      rawOutput: payload,
    });
    await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-3",
      loopVersion: 3,
      model: "gpt-test",
      rawOutput: payload,
    });

    const runs = await db
      .select()
      .from(schema.sdlcDeepReviewRun)
      .where(
        and(
          eq(schema.sdlcDeepReviewRun.loopId, loop!.id),
          eq(schema.sdlcDeepReviewRun.headSha, "sha-3"),
        ),
      );
    const findings = await db
      .select()
      .from(schema.sdlcDeepReviewFinding)
      .where(
        and(
          eq(schema.sdlcDeepReviewFinding.loopId, loop!.id),
          eq(schema.sdlcDeepReviewFinding.headSha, "sha-3"),
        ),
      );

    expect(runs).toHaveLength(1);
    expect(findings).toHaveLength(1);
  });

  it("requires follow-up re-entry while unresolved findings exist", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-4",
      loopVersion: 4,
      model: "gpt-test",
      rawOutput: {
        gatePassed: false,
        blockingFindings: [
          {
            stableFindingId: "stable-2",
            title: "Missing auth check",
            severity: "critical",
            category: "security",
            detail: "Mutation endpoint allows unauthenticated access",
            suggestedFix: "Require auth guard",
            isBlocking: true,
          },
        ],
      },
    });

    const queuedBeforeResolve = await shouldQueueFollowUpForDeepReview({
      db,
      loopId: loop!.id,
      headSha: "sha-4",
    });
    expect(queuedBeforeResolve).toBe(true);

    await resolveDeepReviewFinding({
      db,
      loopId: loop!.id,
      headSha: "sha-4",
      stableFindingId: "stable-2",
      resolvedByEventId: "event-1",
    });

    const queuedAfterResolve = await shouldQueueFollowUpForDeepReview({
      db,
      loopId: loop!.id,
      headSha: "sha-4",
    });
    expect(queuedAfterResolve).toBe(false);
  });

  it("blocks carmack review until deep review has passed for same head", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    const beforeDeepPass = await canRunCarmackReviewForHeadSha({
      db,
      loopId: loop!.id,
      headSha: "sha-5",
    });
    expect(beforeDeepPass).toBe(false);

    await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-5",
      loopVersion: 5,
      model: "gpt-test",
      rawOutput: {
        gatePassed: true,
        blockingFindings: [],
      },
    });

    const afterDeepPass = await canRunCarmackReviewForHeadSha({
      db,
      loopId: loop!.id,
      headSha: "sha-5",
    });
    expect(afterDeepPass).toBe(true);
  });

  it("persists carmack findings with stable identifiers", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-6",
      loopVersion: 6,
      model: "gpt-test",
      rawOutput: {
        gatePassed: true,
        blockingFindings: [],
      },
    });

    const result = await persistCarmackReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-6",
      loopVersion: 6,
      model: "gpt-test",
      rawOutput: {
        gatePassed: false,
        blockingFindings: [
          {
            stableFindingId: "carmack-1",
            title: "Missing deterministic state transition",
            severity: "high",
            category: "fsm",
            detail: "Transition can skip required state",
            suggestedFix: "Add guard to transition predicate",
            isBlocking: true,
          },
          {
            title: "Unstable ordering in evaluator",
            severity: "medium",
            category: "determinism",
            detail: "Findings order depends on map iteration",
            suggestedFix: null,
            isBlocking: true,
          },
        ],
      },
    });

    const findings = await getUnresolvedBlockingCarmackReviewFindings({
      db,
      loopId: loop!.id,
      headSha: "sha-6",
    });

    expect(result.status).toBe("blocked");
    expect(findings).toHaveLength(2);
    expect(
      findings.some((finding) => finding.stableFindingId === "carmack-1"),
    ).toBe(true);
    expect(
      findings.some((finding) =>
        finding.stableFindingId.startsWith("carmack_review_"),
      ),
    ).toBe(true);
  });

  it("requires follow-up re-entry while unresolved carmack findings exist", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
    });

    await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-7",
      loopVersion: 7,
      model: "gpt-test",
      rawOutput: {
        gatePassed: true,
        blockingFindings: [],
      },
    });

    await persistCarmackReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-7",
      loopVersion: 7,
      model: "gpt-test",
      rawOutput: {
        gatePassed: false,
        blockingFindings: [
          {
            stableFindingId: "carmack-2",
            title: "Missing CI capability check",
            severity: "critical",
            category: "gate-correctness",
            detail: "Loop can continue without validated CI capability",
            suggestedFix: "Add hard gate before publication",
            isBlocking: true,
          },
        ],
      },
    });

    const queuedBeforeResolve = await shouldQueueFollowUpForCarmackReview({
      db,
      loopId: loop!.id,
      headSha: "sha-7",
    });
    expect(queuedBeforeResolve).toBe(true);

    await resolveCarmackReviewFinding({
      db,
      loopId: loop!.id,
      headSha: "sha-7",
      stableFindingId: "carmack-2",
      resolvedByEventId: "event-2",
    });

    const queuedAfterResolve = await shouldQueueFollowUpForCarmackReview({
      db,
      loopId: loop!.id,
      headSha: "sha-7",
    });
    expect(queuedAfterResolve).toBe(false);
  });

  it("builds unique canonical cause IDs for repeated PR lifecycle events", () => {
    const closedMerged = buildSdlcCanonicalCause({
      causeType: "pull_request.closed",
      deliveryId: "delivery-a",
      pullRequestId: 123,
      merged: true,
    });
    const closedUnmerged = buildSdlcCanonicalCause({
      causeType: "pull_request.closed",
      deliveryId: "delivery-b",
      pullRequestId: 123,
      merged: false,
    });
    const reopened = buildSdlcCanonicalCause({
      causeType: "pull_request.reopened",
      deliveryId: "delivery-c",
      pullRequestId: 123,
    });
    const edited = buildSdlcCanonicalCause({
      causeType: "pull_request.edited",
      deliveryId: "delivery-d",
      pullRequestId: 123,
    });

    const canonicalIds = new Set([
      closedMerged.canonicalCauseId,
      closedUnmerged.canonicalCauseId,
      reopened.canonicalCauseId,
      edited.canonicalCauseId,
    ]);

    expect(canonicalIds.size).toBe(4);
    expect(closedMerged.canonicalCauseId).toContain("closed:merged");
    expect(closedUnmerged.canonicalCauseId).toContain("closed:unmerged");
    expect(reopened.canonicalCauseId).toContain(":reopened");
    expect(edited.canonicalCauseId).toContain(":edited");
  });

  it("claims, retries, and completes outbox actions under loop lease", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 99,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 99,
      threadId,
    });

    await enqueueSdlcOutboxAction({
      db,
      loopId: loop!.id,
      transitionSeq: 1,
      actionType: "publish_status_comment",
      actionKey: "status:1",
      payload: { body: "status" },
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    const enqueueSecond = await enqueueSdlcOutboxAction({
      db,
      loopId: loop!.id,
      transitionSeq: 2,
      actionType: "publish_check_summary",
      actionKey: "summary:1",
      payload: { summary: "gates" },
      now: new Date("2026-01-01T00:00:01.000Z"),
    });

    expect(enqueueSecond.supersededOutboxCount).toBe(1);

    const lease = await acquireSdlcLoopLease({
      db,
      loopId: loop!.id,
      leaseOwner: "worker-1",
      leaseTtlMs: 600_000,
      now: new Date("2026-01-01T00:00:02.000Z"),
    });
    expect(lease.acquired).toBe(true);

    const claimed = await claimNextSdlcOutboxActionForExecution({
      db,
      loopId: loop!.id,
      leaseOwner: "worker-1",
      leaseEpoch: lease.acquired ? lease.leaseEpoch : 0,
      now: new Date("2026-01-01T00:00:03.000Z"),
    });

    expect(claimed?.id).toBe(enqueueSecond.outboxId);
    expect(claimed?.attemptCount).toBe(1);

    const retryResult = await completeSdlcOutboxActionExecution({
      db,
      outboxId: claimed!.id,
      leaseOwner: "worker-1",
      succeeded: false,
      retriable: true,
      errorClass: "infra",
      errorCode: "github_5xx",
      errorMessage: "GitHub temporary outage",
      now: new Date("2026-01-01T00:00:04.000Z"),
    });

    expect(retryResult.updated).toBe(true);
    if (retryResult.updated) {
      expect(retryResult.status).toBe("pending");
      expect(retryResult.retryAt).not.toBeNull();
    }

    const notReadyYet = await claimNextSdlcOutboxActionForExecution({
      db,
      loopId: loop!.id,
      leaseOwner: "worker-1",
      leaseEpoch: lease.acquired ? lease.leaseEpoch : 0,
      now: new Date("2026-01-01T00:00:10.000Z"),
    });
    expect(notReadyYet).toBeNull();

    const readyAgain = await claimNextSdlcOutboxActionForExecution({
      db,
      loopId: loop!.id,
      leaseOwner: "worker-1",
      leaseEpoch: lease.acquired ? lease.leaseEpoch : 0,
      now: new Date("2026-01-01T00:00:34.000Z"),
    });
    expect(readyAgain?.id).toBe(enqueueSecond.outboxId);
    expect(readyAgain?.attemptCount).toBe(2);

    const completed = await completeSdlcOutboxActionExecution({
      db,
      outboxId: readyAgain!.id,
      leaseOwner: "worker-1",
      succeeded: true,
      now: new Date("2026-01-01T00:00:35.000Z"),
    });
    expect(completed).toMatchObject({
      updated: true,
      status: "completed",
    });

    const attempts = await db.query.sdlcLoopOutboxAttempt.findMany({
      where: eq(schema.sdlcLoopOutboxAttempt.outboxId, enqueueSecond.outboxId),
      orderBy: [schema.sdlcLoopOutboxAttempt.attempt],
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "retry_scheduled",
      "completed",
    ]);
  });

  it("persists canonical GitHub publication references for loop status surfaces", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 100,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 100,
      threadId,
    });

    await persistSdlcCanonicalStatusCommentReference({
      db,
      loopId: loop!.id,
      commentId: "1234567890",
      commentNodeId: "MDU6SXNzdWVDb21tZW50MTIz",
    });

    await persistSdlcCanonicalCheckRunReference({
      db,
      loopId: loop!.id,
      checkRunId: 424242,
    });

    let reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.canonicalStatusCommentId).toBe("1234567890");
    expect(reloaded?.canonicalStatusCommentNodeId).toBe(
      "MDU6SXNzdWVDb21tZW50MTIz",
    );
    expect(reloaded?.canonicalCheckRunId).toBe(424242);

    await clearSdlcCanonicalStatusCommentReference({ db, loopId: loop!.id });

    reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.canonicalStatusCommentId).toBeNull();
    expect(reloaded?.canonicalStatusCommentNodeId).toBeNull();
  });

  it("classifies video capture failures and persists deterministic ready state", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 101,
      },
    });

    const loop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 101,
      threadId,
    });

    const classifiedFailure = classifySdlcVideoCaptureFailure(
      new Error("429 rate limit exceeded for capture quota"),
    );
    expect(classifiedFailure.failureClass).toBe("quota");

    await persistSdlcVideoCaptureOutcome({
      db,
      loopId: loop!.id,
      headSha: "sha-video-1",
      loopVersion: 10,
      artifactR2Key: null,
      failureClass: classifiedFailure.failureClass,
      failureCode: classifiedFailure.failureCode,
      failureMessage: classifiedFailure.failureMessage,
    });

    let reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("video_degraded_ready");
    expect(reloaded?.videoCaptureStatus).toBe("failed");
    expect(reloaded?.latestVideoFailureClass).toBe("quota");

    await persistSdlcVideoCaptureOutcome({
      db,
      loopId: loop!.id,
      headSha: "sha-video-2",
      loopVersion: 11,
      artifactR2Key: "videos/loop-101.mp4",
      artifactMimeType: "video/mp4",
      artifactBytes: 2048,
    });

    reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("human_review_ready");
    expect(reloaded?.videoCaptureStatus).toBe("captured");
    expect(reloaded?.latestVideoArtifactR2Key).toBe("videos/loop-101.mp4");
    expect(reloaded?.latestVideoFailureClass).toBeNull();

    await db
      .update(schema.sdlcLoop)
      .set({ state: "done" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    await persistSdlcVideoCaptureOutcome({
      db,
      loopId: loop!.id,
      headSha: "sha-video-3",
      loopVersion: 12,
      artifactR2Key: null,
      failureClass: "infra",
      failureCode: "video_capture_infra",
      failureMessage: "transient outage",
    });

    reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("done");
  });

  it("computes parity buckets and evaluates cutover/rollback triggers", async () => {
    await recordSdlcParityMetricSample({
      db,
      causeType: "check_run.completed",
      targetClass: "coordinator",
      matched: true,
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await recordSdlcParityMetricSample({
      db,
      causeType: "check_run.completed",
      targetClass: "coordinator",
      matched: false,
      observedAt: new Date("2026-01-01T00:10:00.000Z"),
    });
    await recordSdlcParityMetricSample({
      db,
      causeType: "pull_request.synchronize",
      targetClass: "coordinator",
      matched: true,
      observedAt: new Date("2026-01-01T00:20:00.000Z"),
    });

    const stats = await getSdlcParityBucketStats({
      db,
      windowStart: new Date("2026-01-01T00:00:00.000Z"),
      windowEnd: new Date("2026-01-01T01:00:00.000Z"),
    });

    expect(stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          causeType: "check_run.completed",
          targetClass: "coordinator",
          eligibleCount: 2,
          matchedCount: 1,
        }),
      ]),
    );

    const evaluated = evaluateSdlcParitySlo({
      bucketStats: stats,
      criticalInvariantViolation: false,
    });

    expect(evaluated.cutoverEligible).toBe(false);
    expect(evaluated.rollbackRequired).toBe(true);

    const rollbackFromInvariantBreach = evaluateSdlcParitySlo({
      bucketStats: stats.map((bucket) => ({ ...bucket, parity: 1 })),
      criticalInvariantViolation: true,
    });
    expect(rollbackFromInvariantBreach.rollbackRequired).toBe(true);
  });
});
