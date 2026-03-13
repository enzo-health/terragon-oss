import { describe, expect, it } from "vitest";
import { createDb } from "../db";
import { env } from "@terragon/env/pkg-shared";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid/non-secure";
import { createTestUser, createTestThread } from "./test-helpers";
import {
  enrollSdlcLoopForThread,
  buildSdlcCanonicalCause,
  persistSdlcCiGateEvaluation,
  persistSdlcReviewThreadGateEvaluation,
} from "./delivery-loop";
import {
  getPayloadText,
  getPayloadNonNegativeInteger,
  getPayloadStringArray,
  classifySignalPolicy,
  buildPersistedLoopPhaseContext,
  buildCiRequiredCheckFromSignalPayload,
  deriveReviewUnresolvedThreadCount,
  claimNextUnprocessedSignal,
  refreshSignalClaim,
  releaseSignalClaim,
  completeSignalClaim,
  evaluateBabysitCompletionForHead,
  persistGateEvaluationForSignal,
  getPriorCiRequiredChecksForHead,
  type PendingSignal,
} from "./signal-inbox-core";

const db = createDb(env.DATABASE_URL!);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupLoopWithSignal(opts?: {
  causeType?: string;
  payload?: Record<string, unknown>;
  committed?: boolean;
}) {
  const { user } = await createTestUser({ db });
  const { threadId, threadChatId } = await createTestThread({
    db,
    userId: user.id,
  });
  const loop = await enrollSdlcLoopForThread({
    db,
    userId: user.id,
    repoFullName: "terragon/test-repo",
    threadId,
    currentHeadSha: "test-sha-123",
  });
  if (!loop) throw new Error("Failed to enroll loop");

  const causeType = (opts?.causeType ?? "daemon_terminal") as never;
  const cause = buildSdlcCanonicalCause(
    causeType === "daemon_terminal"
      ? { causeType: "daemon_terminal", eventId: nanoid() }
      : causeType === "check_run.completed"
        ? {
            causeType: "check_run.completed",
            deliveryId: nanoid(),
            checkRunId: 12345,
          }
        : causeType === "pull_request_review"
          ? {
              causeType: "pull_request_review",
              deliveryId: nanoid(),
              reviewId: 1,
              reviewState: "approved",
            }
          : {
              causeType: "pull_request_review_comment",
              deliveryId: nanoid(),
              commentId: 1,
            },
  );

  const now = new Date();
  const [signal] = await db
    .insert(schema.sdlcLoopSignalInbox)
    .values({
      loopId: loop.id,
      causeType: cause.causeType as never,
      canonicalCauseId: cause.canonicalCauseId,
      signalHeadShaOrNull: cause.signalHeadShaOrNull,
      causeIdentityVersion: cause.causeIdentityVersion,
      payload: opts?.payload ?? null,
      receivedAt: now,
      committedAt: opts?.committed !== false ? now : null,
    })
    .returning();

  return {
    user,
    threadId,
    threadChatId,
    loop,
    signal: signal!,
    loopId: loop.id,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("payload helpers", () => {
  describe("getPayloadText", () => {
    it("returns trimmed string value", () => {
      expect(getPayloadText({ key: "  hello  " }, "key")).toBe("hello");
    });

    it("returns null for missing key", () => {
      expect(getPayloadText({ other: "value" }, "key")).toBeNull();
    });

    it("returns null for non-string value", () => {
      expect(getPayloadText({ key: 42 }, "key")).toBeNull();
    });

    it("returns null for empty/whitespace string", () => {
      expect(getPayloadText({ key: "   " }, "key")).toBeNull();
    });

    it("returns null for null payload", () => {
      expect(getPayloadText(null, "key")).toBeNull();
    });
  });

  describe("getPayloadNonNegativeInteger", () => {
    it("returns truncated non-negative integer", () => {
      expect(getPayloadNonNegativeInteger({ n: 5.9 }, "n")).toBe(5);
    });

    it("returns 0 for zero", () => {
      expect(getPayloadNonNegativeInteger({ n: 0 }, "n")).toBe(0);
    });

    it("returns null for negative number", () => {
      expect(getPayloadNonNegativeInteger({ n: -1 }, "n")).toBeNull();
    });

    it("returns null for non-number", () => {
      expect(getPayloadNonNegativeInteger({ n: "5" }, "n")).toBeNull();
    });

    it("returns null for null payload", () => {
      expect(getPayloadNonNegativeInteger(null, "n")).toBeNull();
    });

    it("returns null for Infinity", () => {
      expect(getPayloadNonNegativeInteger({ n: Infinity }, "n")).toBeNull();
    });
  });

  describe("getPayloadStringArray", () => {
    it("returns deduplicated sorted string array", () => {
      expect(getPayloadStringArray({ a: ["c", "a", "b", "a"] }, "a")).toEqual([
        "a",
        "b",
        "c",
      ]);
    });

    it("filters out non-string values", () => {
      expect(
        getPayloadStringArray({ a: ["ok", 42, null, "yes"] }, "a"),
      ).toEqual(["ok", "yes"]);
    });

    it("returns null for empty array after filtering", () => {
      expect(getPayloadStringArray({ a: [42, null] }, "a")).toBeNull();
    });

    it("returns null for non-array", () => {
      expect(getPayloadStringArray({ a: "not-array" }, "a")).toBeNull();
    });

    it("returns null for null payload", () => {
      expect(getPayloadStringArray(null, "a")).toBeNull();
    });

    it("filters out whitespace-only strings", () => {
      expect(getPayloadStringArray({ a: ["  ", "ok"] }, "a")).toEqual(["ok"]);
    });
  });
});

describe("classifySignalPolicy", () => {
  it("classifies daemon_terminal as feedback signal with routing without PR", () => {
    const policy = classifySignalPolicy("daemon_terminal");
    expect(policy.isFeedbackSignal).toBe(true);
    expect(policy.allowRoutingWithoutPrLink).toBe(true);
    expect(policy.suppressPlanningRuntimeRouting).toBe(true);
  });

  it("classifies check_run.completed as feedback signal", () => {
    const policy = classifySignalPolicy("check_run.completed");
    expect(policy.isFeedbackSignal).toBe(true);
    expect(policy.allowRoutingWithoutPrLink).toBe(false);
  });

  it("classifies pull_request.synchronize as non-feedback signal", () => {
    const policy = classifySignalPolicy("pull_request.synchronize");
    expect(policy.isFeedbackSignal).toBe(false);
    expect(policy.allowRoutingWithoutPrLink).toBe(false);
    expect(policy.suppressPlanningRuntimeRouting).toBe(false);
  });
});

describe("buildPersistedLoopPhaseContext", () => {
  it("returns implementing phase for implementing state", () => {
    const ctx = buildPersistedLoopPhaseContext({ state: "implementing" });
    expect(ctx.effectivePhase).toBe("implementing");
    expect(ctx.snapshot.kind).toBe("implementing");
  });

  it("returns blocked origin for blocked state", () => {
    const ctx = buildPersistedLoopPhaseContext({
      state: "blocked",
      blockedFromState: "ci_gate",
    });
    expect(ctx.effectivePhase).toBe("ci_gate");
    expect(ctx.snapshot.kind).toBe("blocked");
  });
});

describe("buildCiRequiredCheckFromSignalPayload", () => {
  it("prefers checkName over checkSuiteId", () => {
    expect(
      buildCiRequiredCheckFromSignalPayload({
        checkName: "ci/build",
        checkSuiteId: "123",
      }),
    ).toBe("ci/build");
  });

  it("falls back to check-suite: prefix", () => {
    expect(buildCiRequiredCheckFromSignalPayload({ checkSuiteId: "456" })).toBe(
      "check-suite:456",
    );
  });

  it("returns null when neither present", () => {
    expect(buildCiRequiredCheckFromSignalPayload({})).toBeNull();
  });
});

describe("deriveReviewUnresolvedThreadCount", () => {
  const baseSignal: PendingSignal = {
    id: "sig-1",
    causeType: "pull_request_review",
    canonicalCauseId: "cause-1",
    payload: null,
    receivedAt: new Date(),
    claimToken: "tok-1",
  };

  it("returns explicit unresolvedThreadCount from payload", () => {
    expect(
      deriveReviewUnresolvedThreadCount({
        signal: baseSignal,
        payload: { unresolvedThreadCount: 3 },
      }),
    ).toBe(3);
  });

  it("returns 1 for pull_request_review_comment without explicit count", () => {
    expect(
      deriveReviewUnresolvedThreadCount({
        signal: { ...baseSignal, causeType: "pull_request_review_comment" },
        payload: {},
      }),
    ).toBe(1);
  });

  it("returns 0 for approved review state", () => {
    expect(
      deriveReviewUnresolvedThreadCount({
        signal: baseSignal,
        payload: { reviewState: "approved" },
      }),
    ).toBe(0);
  });

  it("returns 1 for changes_requested review state", () => {
    expect(
      deriveReviewUnresolvedThreadCount({
        signal: baseSignal,
        payload: { reviewState: "changes_requested" },
      }),
    ).toBe(1);
  });

  it("returns null when nothing can be derived", () => {
    expect(
      deriveReviewUnresolvedThreadCount({
        signal: baseSignal,
        payload: {},
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DB function tests
// ---------------------------------------------------------------------------

describe("signal claim lifecycle", () => {
  it("claims the next unprocessed signal", async () => {
    const { loopId } = await setupLoopWithSignal();

    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "test-claim-token",
      now: new Date(),
      staleClaimMs: 0,
    });

    expect(claimed).not.toBeNull();
    expect(claimed!.causeType).toBe("daemon_terminal");
    expect(claimed!.claimToken).toBe("test-claim-token");
  });

  it("returns null when no unprocessed signals exist", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({ db, userId: user.id });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "terragon/test-repo",
      threadId,
    });

    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId: loop!.id,
      claimToken: "test-claim-token",
      now: new Date(),
      staleClaimMs: 0,
    });

    expect(claimed).toBeNull();
  });

  it("skips uncommitted daemon_terminal signals", async () => {
    const { loopId } = await setupLoopWithSignal({
      causeType: "daemon_terminal",
      committed: false,
    });

    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "test-claim-token",
      now: new Date(),
      staleClaimMs: 0,
    });

    expect(claimed).toBeNull();
  });

  it("steals stale claims", async () => {
    const { loopId, signal } = await setupLoopWithSignal();
    const staleTime = new Date(Date.now() - 120_000);

    // First claim (simulate stale)
    await db
      .update(schema.sdlcLoopSignalInbox)
      .set({ claimToken: "old-token", claimedAt: staleTime })
      .where(eq(schema.sdlcLoopSignalInbox.id, signal.id));

    // Second claim should steal it
    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "new-token",
      now: new Date(),
      staleClaimMs: 60_000,
    });

    expect(claimed).not.toBeNull();
    expect(claimed!.claimToken).toBe("new-token");
  });

  it("refreshes a signal claim", async () => {
    const { loopId } = await setupLoopWithSignal();
    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "refresh-token",
      now: new Date(),
      staleClaimMs: 0,
    });

    const refreshed = await refreshSignalClaim({
      db,
      signalId: claimed!.id,
      claimToken: "refresh-token",
      now: new Date(),
    });
    expect(refreshed).toBe(true);
  });

  it("fails to refresh with wrong claim token", async () => {
    const { loopId } = await setupLoopWithSignal();
    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "correct-token",
      now: new Date(),
      staleClaimMs: 0,
    });

    const refreshed = await refreshSignalClaim({
      db,
      signalId: claimed!.id,
      claimToken: "wrong-token",
      now: new Date(),
    });
    expect(refreshed).toBe(false);
  });

  it("releases a signal claim", async () => {
    const { loopId } = await setupLoopWithSignal();
    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "release-token",
      now: new Date(),
      staleClaimMs: 0,
    });

    await releaseSignalClaim({
      db,
      signalId: claimed!.id,
      claimToken: "release-token",
    });

    // Signal should be claimable again
    const reclaimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "new-token",
      now: new Date(),
      staleClaimMs: 0,
    });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(claimed!.id);
  });

  it("completes a signal claim (marks processed)", async () => {
    const { loopId } = await setupLoopWithSignal();
    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "complete-token",
      now: new Date(),
      staleClaimMs: 0,
    });

    const completed = await completeSignalClaim({
      db,
      signalId: claimed!.id,
      claimToken: "complete-token",
      now: new Date(),
    });
    expect(completed).toBe(true);

    // Signal should NOT be claimable again
    const reclaimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "another-token",
      now: new Date(),
      staleClaimMs: 0,
    });
    expect(reclaimed).toBeNull();
  });

  it("fails to complete with wrong claim token", async () => {
    const { loopId } = await setupLoopWithSignal();
    const claimed = await claimNextUnprocessedSignal({
      db,
      loopId,
      claimToken: "correct-token",
      now: new Date(),
      staleClaimMs: 0,
    });

    const completed = await completeSignalClaim({
      db,
      signalId: claimed!.id,
      claimToken: "wrong-token",
      now: new Date(),
    });
    expect(completed).toBe(false);
  });
});

describe("evaluateBabysitCompletionForHead", () => {
  it("returns allRequiredGatesPassed=false when no CI gate run exists", async () => {
    const { loopId } = await setupLoopWithSignal();

    const result = await evaluateBabysitCompletionForHead({
      db,
      loopId,
      headSha: "nonexistent-sha",
    });

    expect(result.requiredCiPassed).toBe(false);
    expect(result.allRequiredGatesPassed).toBe(false);
  });

  it("returns allRequiredGatesPassed=true when CI + review gates pass", async () => {
    const { loopId } = await setupLoopWithSignal();
    const headSha = "test-sha-babysit";

    // Persist a passing CI gate
    await persistSdlcCiGateEvaluation({
      db,
      loopId,
      headSha,
      loopVersion: 1,
      triggerEventType: "check_run.completed",
      capabilityState: "supported",
      rulesetChecks: ["ci/build"],
      failingChecks: [],
    });

    // Persist a passing review gate
    await persistSdlcReviewThreadGateEvaluation({
      db,
      loopId,
      headSha,
      loopVersion: 1,
      triggerEventType: "pull_request_review.submitted",
      evaluationSource: "webhook",
      unresolvedThreadCount: 0,
    });

    const result = await evaluateBabysitCompletionForHead({
      db,
      loopId,
      headSha,
    });

    expect(result.requiredCiPassed).toBe(true);
    expect(result.unresolvedReviewThreads).toBe(0);
    expect(result.unresolvedDeepBlockers).toBe(0);
    expect(result.unresolvedCarmackBlockers).toBe(0);
    expect(result.allRequiredGatesPassed).toBe(true);
  });

  it("detects unresolved review threads", async () => {
    const { loopId } = await setupLoopWithSignal();
    const headSha = "test-sha-review-threads";

    await persistSdlcCiGateEvaluation({
      db,
      loopId,
      headSha,
      loopVersion: 1,
      triggerEventType: "check_run.completed",
      capabilityState: "supported",
      rulesetChecks: ["ci/build"],
      failingChecks: [],
    });

    await persistSdlcReviewThreadGateEvaluation({
      db,
      loopId,
      headSha,
      loopVersion: 1,
      triggerEventType: "pull_request_review.submitted",
      evaluationSource: "webhook",
      unresolvedThreadCount: 2,
    });

    const result = await evaluateBabysitCompletionForHead({
      db,
      loopId,
      headSha,
    });

    expect(result.unresolvedReviewThreads).toBe(2);
    expect(result.allRequiredGatesPassed).toBe(false);
  });
});

describe("getPriorCiRequiredChecksForHead", () => {
  it("returns null when no prior CI run exists", async () => {
    const { loopId } = await setupLoopWithSignal();
    const result = await getPriorCiRequiredChecksForHead({
      db,
      loopId,
      headSha: "no-prior-sha",
    });
    expect(result).toBeNull();
  });

  it("returns sorted deduplicated required checks from latest CI run", async () => {
    const { loopId } = await setupLoopWithSignal();
    const headSha = "prior-checks-sha";

    await persistSdlcCiGateEvaluation({
      db,
      loopId,
      headSha,
      loopVersion: 1,
      triggerEventType: "check_run.completed",
      capabilityState: "supported",
      rulesetChecks: ["ci/test", "ci/build"],
      failingChecks: [],
    });

    const result = await getPriorCiRequiredChecksForHead({
      db,
      loopId,
      headSha,
    });

    expect(result).not.toBeNull();
    expect(result).toEqual(expect.arrayContaining(["ci/build", "ci/test"]));
  });
});

describe("persistGateEvaluationForSignal", () => {
  it("returns true for daemon_terminal with completed status", async () => {
    const { loopId, loop } = await setupLoopWithSignal();

    const result = await persistGateEvaluationForSignal({
      db,
      loop: {
        id: loopId,
        loopVersion: loop.loopVersion,
        currentHeadSha: "test-sha-123",
        state: loop.state,
        blockedFromState: null,
      },
      signal: {
        id: "sig-1",
        causeType: "daemon_terminal",
        canonicalCauseId: "cause-1",
        payload: { daemonRunStatus: "completed" },
        receivedAt: new Date(),
        claimToken: "tok-1",
      },
      now: new Date(),
    });

    expect(result).toBe(true);
  });

  it("returns false for daemon_terminal with stopped status", async () => {
    const { loopId, loop } = await setupLoopWithSignal();

    const result = await persistGateEvaluationForSignal({
      db,
      loop: {
        id: loopId,
        loopVersion: loop.loopVersion,
        currentHeadSha: "test-sha-123",
        state: loop.state,
        blockedFromState: null,
      },
      signal: {
        id: "sig-2",
        causeType: "daemon_terminal",
        canonicalCauseId: "cause-2",
        payload: { daemonRunStatus: "stopped" },
        receivedAt: new Date(),
        claimToken: "tok-2",
      },
      now: new Date(),
    });

    expect(result).toBe(false);
  });

  it("returns false for non-feedback cause types", async () => {
    const { loopId, loop } = await setupLoopWithSignal();

    const result = await persistGateEvaluationForSignal({
      db,
      loop: {
        id: loopId,
        loopVersion: loop.loopVersion,
        currentHeadSha: "test-sha-123",
        state: loop.state,
        blockedFromState: null,
      },
      signal: {
        id: "sig-3",
        causeType: "pull_request.synchronize",
        canonicalCauseId: "cause-3",
        payload: {},
        receivedAt: new Date(),
        claimToken: "tok-3",
      },
      now: new Date(),
    });

    expect(result).toBe(false);
  });

  it("returns false for CI signal missing headSha", async () => {
    const { loopId, loop } = await setupLoopWithSignal();

    const result = await persistGateEvaluationForSignal({
      db,
      loop: {
        id: loopId,
        loopVersion: loop.loopVersion,
        currentHeadSha: null,
        state: loop.state,
        blockedFromState: null,
      },
      signal: {
        id: "sig-4",
        causeType: "check_run.completed",
        canonicalCauseId: "cause-4",
        payload: { checkOutcome: "pass" },
        receivedAt: new Date(),
        claimToken: "tok-4",
      },
      now: new Date(),
    });

    expect(result).toBe(false);
  });
});
