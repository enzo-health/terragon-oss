import { beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../db";
import { env } from "@terragon/env/pkg-shared";
import * as schema from "../db/schema";
import { and, eq } from "drizzle-orm";
import { createTestThread, createTestUser } from "./test-helpers";
import {
  acquireSdlcLoopLease,
  buildDeliveryLoopCompanionFields,
  buildDeliveryLoopSnapshot,
  buildSdlcCanonicalCause,
  canRunCarmackReviewForHeadSha,
  claimGithubWebhookDelivery,
  completeGithubWebhookDelivery,
  createImplementationArtifactForHead,
  createPlanArtifactForLoop,
  evaluateSdlcLoopGuardrails,
  enrollSdlcLoopForGithubPR,
  enrollSdlcLoopForThread,
  getActiveSdlcLoopForThread,
  getUnresolvedBlockingCarmackReviewFindings,
  getActiveSdlcLoopForGithubPRAndUser,
  getActiveSdlcLoopForGithubPR,
  getActiveSdlcLoopsForGithubPR,
  getPreferredActiveSdlcLoopForGithubPRAndUser,
  clearSdlcCanonicalStatusCommentReference,
  persistCarmackReviewGateResult,
  persistSdlcCanonicalCheckRunReference,
  persistSdlcCanonicalStatusCommentReference,
  persistSdlcCiGateEvaluation,
  replacePlanTasksForArtifact,
  approvePlanArtifactForLoop,
  persistDeepReviewGateResult,
  persistSdlcReviewThreadGateEvaluation,
  releaseGithubWebhookDeliveryClaim,
  releaseSdlcLoopLease,
  linkSdlcLoopToGithubPRForThread,
  markPlanTasksCompletedByAgent,
  mapSdlcTransitionEventToDeliveryLoopTransition,
  normalizeBlockedReasonCategory,
  createAwaitingPrLinkSnapshot,
  createBabysittingSnapshot,
  createBlockedSnapshot,
  buildPersistedDeliveryLoopSnapshot,
  createCiGateSnapshot,
  createDoneSnapshot,
  createImplementingSnapshot,
  createPlanningSnapshot,
  createReviewGateSnapshot,
  createStoppedSnapshot,
  createTerminatedPrClosedSnapshot,
  createTerminatedPrMergedSnapshot,
  createUiGateSnapshot,
  deliveryLoopCompanionFieldDefaults,
  getEffectiveDeliveryLoopPhase,
  reduceDeliveryLoopSnapshot,
  reducePersistedDeliveryLoopState,
  resolveCarmackReviewFinding,
  resolveDeliveryLoopNextState,
  resolveBlockedResumeTarget,
  getUnresolvedBlockingDeepReviewFindings,
  resolveDeepReviewFinding,
  shouldQueueFollowUpForCarmackReview,
  shouldQueueFollowUpForDeepReview,
  transitionSdlcLoopStateWithArtifact,
  transitionSdlcLoopState,
  verifyPlanTaskCompletionForHead,
  isStaleNoop,
} from "./delivery-loop";

const db = createDb(env.DATABASE_URL!);

describe("delivery loop state model", () => {
  it("builds canonical discriminated snapshots through explicit helpers", () => {
    expect(
      createPlanningSnapshot({
        selectedAgent: "codex",
        nextPhaseTarget: "implementing",
      }),
    ).toEqual({
      kind: "planning",
      selectedAgent: "codex",
      nextPhaseTarget: "implementing",
      dispatchStatus: null,
      dispatchAttemptCount: 0,
      activeRunId: null,
      lastFailureCategory: null,
    });

    expect(
      createImplementingSnapshot({
        selectedAgent: "claudeCode",
        dispatchStatus: "acknowledged",
        dispatchAttemptCount: 2,
        activeRunId: "run_123",
      }),
    ).toEqual({
      kind: "implementing",
      execution: {
        kind: "implementation",
        selectedAgent: "claudeCode",
        dispatchStatus: "acknowledged",
        dispatchAttemptCount: 2,
        activeRunId: "run_123",
        lastFailureCategory: null,
      },
    });

    expect(createReviewGateSnapshot({ gateRunId: "gate_review" })).toEqual({
      kind: "review_gate",
      gate: {
        gateRunId: "gate_review",
        lastFailureCategory: null,
      },
    });
    expect(createCiGateSnapshot({ gateRunId: "gate_ci" })).toEqual({
      kind: "ci_gate",
      gate: {
        gateRunId: "gate_ci",
        lastFailureCategory: null,
      },
    });
    expect(createUiGateSnapshot({ gateRunId: "gate_ui" })).toEqual({
      kind: "ui_gate",
      gate: {
        gateRunId: "gate_ui",
        lastFailureCategory: null,
      },
    });
    expect(createAwaitingPrLinkSnapshot({ selectedAgent: "codex" })).toEqual({
      kind: "awaiting_pr_link",
      selectedAgent: "codex",
      lastFailureCategory: null,
    });
    expect(createBabysittingSnapshot({ selectedAgent: "claudeCode" })).toEqual({
      kind: "babysitting",
      selectedAgent: "claudeCode",
      lastFailureCategory: null,
    });
    expect(createDoneSnapshot()).toEqual({ kind: "done" });
    expect(createStoppedSnapshot()).toEqual({ kind: "stopped" });
    expect(createTerminatedPrClosedSnapshot()).toEqual({
      kind: "terminated_pr_closed",
    });
    expect(createTerminatedPrMergedSnapshot()).toEqual({
      kind: "terminated_pr_merged",
    });
  });

  it("builds a blocked snapshot with normalized reason and resumable origin", () => {
    const snapshot = createBlockedSnapshot({
      selectedAgent: "codex",
      from: "review_gate",
      reason: "gate_failure",
      dispatchStatus: "failed",
      dispatchAttemptCount: 2,
      activeRunId: "run_123",
      activeGateRunId: "gate_123",
      lastFailureCategory: "gate_failed",
    });

    expect(snapshot).toEqual({
      kind: "blocked",
      from: "review_gate",
      reason: "gate_failure",
      selectedAgent: "codex",
      dispatchStatus: "failed",
      dispatchAttemptCount: 2,
      activeRunId: "run_123",
      activeGateRunId: "gate_123",
      lastFailureCategory: "gate_failed",
    });
  });

  it("falls back blocked snapshots to implementing with unknown reason", () => {
    const snapshot = createBlockedSnapshot({
      reason: "mystery_failure",
    });

    expect(snapshot).toEqual({
      kind: "blocked",
      from: "implementing",
      reason: "unknown",
      selectedAgent: null,
      dispatchStatus: null,
      dispatchAttemptCount: 0,
      activeRunId: null,
      activeGateRunId: null,
      lastFailureCategory: null,
    });
  });

  it("resumes blocked state back to its origin instead of always implementing", () => {
    expect(
      resolveDeliveryLoopNextState({
        currentState: "blocked",
        event: "blocked_resume",
        blockedFromState: "planning",
      }),
    ).toBe("planning");

    expect(
      resolveDeliveryLoopNextState({
        currentState: "blocked",
        event: "blocked_resume",
        blockedFromState: "awaiting_pr_link",
      }),
    ).toBe("awaiting_pr_link");
  });

  it("builds persisted blocked snapshots through one shared fallback helper", () => {
    expect(
      buildPersistedDeliveryLoopSnapshot({
        state: "blocked",
      }),
    ).toEqual({
      kind: "blocked",
      from: "implementing",
      reason: "unknown",
      selectedAgent: null,
      dispatchStatus: null,
      dispatchAttemptCount: 0,
      activeRunId: null,
      activeGateRunId: null,
      lastFailureCategory: null,
    });
  });

  it("preserves persisted blocked origin when rebuilding canonical snapshots", () => {
    expect(
      buildPersistedDeliveryLoopSnapshot({
        state: "blocked",
        blockedFromState: "review_gate",
      }),
    ).toEqual({
      kind: "blocked",
      from: "review_gate",
      reason: "unknown",
      selectedAgent: null,
      dispatchStatus: null,
      dispatchAttemptCount: 0,
      activeRunId: null,
      activeGateRunId: null,
      lastFailureCategory: null,
    });
  });

  it("exposes strict blocked helper normalization", () => {
    expect(resolveBlockedResumeTarget("babysitting")).toBe("babysitting");
    expect(resolveBlockedResumeTarget(null)).toBe("implementing");
    expect(normalizeBlockedReasonCategory("runtime_failure")).toBe(
      "runtime_failure",
    );
    expect(normalizeBlockedReasonCategory("bad_value")).toBe("unknown");
  });

  it("maps canonical-compatible legacy transition events into reducer events", () => {
    expect(
      mapSdlcTransitionEventToDeliveryLoopTransition("review_passed"),
    ).toBe("review_gate_passed");
    expect(
      mapSdlcTransitionEventToDeliveryLoopTransition(
        "blocked_resume_requested",
      ),
    ).toBe("blocked_resume");
    expect(
      mapSdlcTransitionEventToDeliveryLoopTransition("implementation_progress"),
    ).toBeNull();
    expect(
      mapSdlcTransitionEventToDeliveryLoopTransition("ui_smoke_passed", {
        hasPrLink: false,
      }),
    ).toBe("ui_gate_passed_without_pr");
    expect(
      mapSdlcTransitionEventToDeliveryLoopTransition("ui_smoke_passed", {
        hasPrLink: true,
      }),
    ).toBe("ui_gate_passed_with_pr");
    expect(
      mapSdlcTransitionEventToDeliveryLoopTransition(
        "video_capture_succeeded",
        {
          hasPrLink: false,
        },
      ),
    ).toBe("ui_gate_passed_without_pr");
  });

  it("resolves effective phase from blocked and non-blocked snapshots", () => {
    expect(getEffectiveDeliveryLoopPhase(createCiGateSnapshot())).toBe(
      "ci_gate",
    );
    expect(
      getEffectiveDeliveryLoopPhase(
        createBlockedSnapshot({
          from: "review_gate",
        }),
      ),
    ).toBe("review_gate");
  });

  it("reduces persisted loop state through the shared persisted snapshot bridge", () => {
    const reduced = reducePersistedDeliveryLoopState({
      state: "blocked",
      blockedFromState: "review_gate",
      event: "blocked_resume",
    });

    expect(reduced).toEqual({
      state: "review_gate",
      snapshot: {
        kind: "review_gate",
        gate: {
          gateRunId: null,
          lastFailureCategory: null,
        },
      },
      companionFields: {
        ...deliveryLoopCompanionFieldDefaults,
        activeGateRunId: null,
        lastFailureCategory: null,
      },
    });
  });

  it("round-trips snapshot metadata back into companion fields", () => {
    const snapshot = buildDeliveryLoopSnapshot({
      state: "implementing",
      companionFields: {
        selectedAgent: "claudeCode",
        dispatchStatus: "acknowledged",
        dispatchAttemptCount: 3,
        activeRunId: "run_impl_123",
        lastFailureCategory: "dispatch_ack_timeout",
      },
    });

    expect(buildDeliveryLoopCompanionFields(snapshot)).toEqual({
      selectedAgent: "claudeCode",
      nextPhaseTarget: null,
      dispatchStatus: "acknowledged",
      dispatchAttemptCount: 3,
      blockedReasonCategory: null,
      blockedFromState: null,
      activeRunId: "run_impl_123",
      activeGateRunId: null,
      lastFailureCategory: "dispatch_ack_timeout",
    });
    expect(snapshot.kind).toBe("implementing");
  });

  it("reduces retry exhaustion into a blocked snapshot with preserved origin", () => {
    const result = reduceDeliveryLoopSnapshot({
      snapshot: buildDeliveryLoopSnapshot({
        state: "ci_gate",
        companionFields: {
          activeGateRunId: "gate_ci_123",
          lastFailureCategory: "daemon_unreachable",
        },
      }),
      event: "exhausted_retryable_failure",
    });

    expect(result).toEqual({
      state: "blocked",
      snapshot: {
        kind: "blocked",
        from: "ci_gate",
        reason: "runtime_failure",
        selectedAgent: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        activeRunId: null,
        activeGateRunId: "gate_ci_123",
        lastFailureCategory: "daemon_unreachable",
      },
      companionFields: {
        selectedAgent: null,
        nextPhaseTarget: null,
        dispatchStatus: null,
        dispatchAttemptCount: 0,
        blockedReasonCategory: "runtime_failure",
        blockedFromState: "ci_gate",
        activeRunId: null,
        activeGateRunId: "gate_ci_123",
        lastFailureCategory: "daemon_unreachable",
      },
    });
  });
});

describe("sdlc loop model", () => {
  beforeEach(async () => {
    await db.delete(schema.sdlcCarmackReviewFinding);
    await db.delete(schema.sdlcCarmackReviewRun);
    await db.delete(schema.sdlcReviewThreadGateRun);
    await db.delete(schema.sdlcCiGateRun);
    await db.delete(schema.sdlcDeepReviewFinding);
    await db.delete(schema.sdlcDeepReviewRun);
    await db.delete(schema.sdlcPlanTask);
    await db.delete(schema.sdlcPhaseArtifact);
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

  it("enrolls thread-scoped loop with nullable PR by default", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
      currentHeadSha: "sha-thread-enroll",
    });

    expect(loop).toBeDefined();
    expect(loop?.prNumber).toBeNull();
    expect(loop?.state).toBe("planning");
    expect(loop?.currentHeadSha).toBe("sha-thread-enroll");
  });

  it("links an enrolled thread-scoped loop to a PR later", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    const linked = await linkSdlcLoopToGithubPRForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
      prNumber: 77,
      currentHeadSha: "sha-linked",
    });

    expect(linked).toBeDefined();
    expect(linked?.prNumber).toBe(77);
    expect(linked?.currentHeadSha).toBe("sha-linked");
  });

  it("prefers canonical github_pr thread when multiple loops map to same PR and user", async () => {
    const { user } = await createTestUser({ db });
    const { threadId: canonicalThreadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const { threadId: siblingThreadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    const canonicalLoop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 88,
      threadId: canonicalThreadId,
    });
    const siblingLoop = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 88,
      threadId: siblingThreadId,
    });

    await db
      .insert(schema.githubPR)
      .values({
        repoFullName: "owner/repo",
        number: 88,
        threadId: canonicalThreadId,
      })
      .onConflictDoNothing();

    const preferred = await getPreferredActiveSdlcLoopForGithubPRAndUser({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 88,
    });

    expect(preferred?.id).toBe(canonicalLoop?.id);
    expect(preferred?.id).not.toBe(siblingLoop?.id);
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

  it("returns all active enrollments for repo/pr across users", async () => {
    const { user: userA } = await createTestUser({ db });
    const { user: userB } = await createTestUser({ db });
    const { threadId: threadIdA } = await createTestThread({
      db,
      userId: userA.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });
    const { threadId: threadIdB } = await createTestThread({
      db,
      userId: userB.id,
      overrides: {
        githubRepoFullName: "owner/repo",
        githubPRNumber: 42,
      },
    });

    await enrollSdlcLoopForGithubPR({
      db,
      userId: userA.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId: threadIdA,
      currentHeadSha: "sha-user-a",
    });
    await enrollSdlcLoopForGithubPR({
      db,
      userId: userB.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId: threadIdB,
      currentHeadSha: "sha-user-b",
    });

    const loops = await getActiveSdlcLoopsForGithubPR({
      db,
      repoFullName: "owner/repo",
      prNumber: 42,
    });

    expect(loops).toHaveLength(2);
    expect(loops.map((loop) => loop.userId).sort()).toEqual(
      [userA.id, userB.id].sort(),
    );
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
    expect(second?.state).toBe("planning");
  });

  it("reactivates a terminal enrollment when thread uniqueness prevents reinsert", async () => {
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

    await db
      .update(schema.sdlcLoop)
      .set({ state: "terminated_pr_closed", stopReason: "test-terminal" })
      .where(eq(schema.sdlcLoop.id, first!.id));

    const reenrolled = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      prNumber: 42,
      threadId,
      currentHeadSha: "sha-reactivated",
    });

    expect(reenrolled?.id).toBe(first?.id);
    expect(reenrolled?.state).toBe("planning");
    expect(reenrolled?.currentHeadSha).toBe("sha-reactivated");
    expect(reenrolled?.stopReason).toBeNull();
  });

  it("does not return non-active historical rows on thread conflict for another repo/pr", async () => {
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
      .set({ state: "terminated_pr_closed" })
      .where(eq(schema.sdlcLoop.id, enrolled!.id));

    const conflictResult = await enrollSdlcLoopForGithubPR({
      db,
      userId: user.id,
      repoFullName: "owner/other-repo",
      prNumber: 99,
      threadId,
    });

    expect(conflictResult).toBeUndefined();
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

  it("does not transition planning->implementing without an accepted/approved plan artifact", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });
    expect(loop).toBeDefined();

    const planArtifact = await createPlanArtifactForLoop({
      db,
      loopId: loop!.id,
      loopVersion: 1,
      status: "generated",
      generatedBy: "agent",
      payload: {
        planText: "Plan text",
        source: "agent_text",
        tasks: [
          {
            stableTaskId: "task-1",
            title: "Implement core flow",
            acceptance: [],
          },
        ],
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Implement core flow",
          acceptance: [],
        },
      ],
    });

    const transitionResult = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      expectedPhase: "planning",
      transitionEvent: "plan_completed",
      loopVersion: 1,
    });

    expect(transitionResult).toBe("artifact_gate_failed");
    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("planning");
  });

  it("requires explicit human approval before transitioning planning->implementing when policy is human_required", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
      planApprovalPolicy: "human_required",
    });
    expect(loop?.planApprovalPolicy).toBe("human_required");

    const planArtifact = await createPlanArtifactForLoop({
      db,
      loopId: loop!.id,
      loopVersion: 2,
      status: "generated",
      generatedBy: "agent",
      payload: {
        planText: "Human approval required plan",
        source: "agent_text",
        tasks: [
          {
            stableTaskId: "task-1",
            title: "Implement",
            acceptance: [],
          },
        ],
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Implement",
          acceptance: [],
        },
      ],
    });

    const blockedResult = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      expectedPhase: "planning",
      transitionEvent: "plan_completed",
      loopVersion: 2,
    });
    expect(blockedResult).toBe("artifact_gate_failed");

    const approvedPlan = await approvePlanArtifactForLoop({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      approvedByUserId: user.id,
    });
    expect(approvedPlan?.status).toBe("approved");

    const transitioned = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      expectedPhase: "planning",
      transitionEvent: "plan_completed",
      loopVersion: 2,
    });
    expect(transitioned).toBe("updated");

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("implementing");
  });

  it("does not advance artifact pointers when transition outcome is not updated", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
      currentHeadSha: "sha-impl-1",
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "implementing",
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const baselineArtifact = await createImplementationArtifactForHead({
      db,
      loopId: loop!.id,
      headSha: "sha-impl-1",
      loopVersion: 11,
      payload: {
        headSha: "sha-impl-1",
        summary: "Baseline implementation snapshot",
        changedFiles: ["baseline.ts"],
        completedTaskIds: [],
      },
      status: "accepted",
      generatedBy: "system",
    });

    const implementationArtifact = await createImplementationArtifactForHead({
      db,
      loopId: loop!.id,
      headSha: "sha-impl-1",
      loopVersion: 12,
      payload: {
        headSha: "sha-impl-1",
        summary: "Implementation snapshot",
        changedFiles: ["file.ts"],
        completedTaskIds: [],
      },
      status: "accepted",
      generatedBy: "system",
    });
    await db
      .update(schema.sdlcLoop)
      .set({
        activeImplementationArtifactId: baselineArtifact.id,
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const transitionResult = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: loop!.id,
      artifactId: implementationArtifact.id,
      expectedPhase: "implementing",
      transitionEvent: "implementation_completed",
      headSha: "sha-impl-1",
      loopVersion: 5,
    });

    expect(transitionResult).toBe("artifact_gate_failed");
    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.activeImplementationArtifactId).toBe(
      baselineArtifact.id,
    );
    expect(reloadedLoop?.state).toBe("implementing");
  });

  it("verifies plan task completion before implementing->reviewing transition", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
      currentHeadSha: "sha-impl-1",
    });
    expect(loop).toBeDefined();
    await db
      .update(schema.sdlcLoop)
      .set({ state: "implementing" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const planArtifact = await createPlanArtifactForLoop({
      db,
      loopId: loop!.id,
      loopVersion: 3,
      status: "accepted",
      generatedBy: "agent",
      payload: {
        planText: "Implementation plan",
        source: "agent_text",
        tasks: [
          {
            stableTaskId: "task-1",
            title: "Add models",
            acceptance: [],
          },
          {
            stableTaskId: "task-2",
            title: "Wire orchestrator",
            acceptance: [],
          },
        ],
      },
    });
    await replacePlanTasksForArtifact({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      tasks: [
        {
          stableTaskId: "task-1",
          title: "Add models",
          acceptance: [],
        },
        {
          stableTaskId: "task-2",
          title: "Wire orchestrator",
          acceptance: [],
        },
      ],
    });

    const initialVerification = await verifyPlanTaskCompletionForHead({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      headSha: "sha-impl-1",
    });
    expect(initialVerification.gatePassed).toBe(false);
    expect(initialVerification.incompleteTaskIds).toEqual(["task-1", "task-2"]);

    await markPlanTasksCompletedByAgent({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      completions: [
        {
          stableTaskId: "task-1",
          status: "done",
          evidence: { headSha: "sha-impl-1", changedFiles: ["a.ts"] },
        },
        {
          stableTaskId: "task-2",
          status: "done",
          evidence: { headSha: "sha-impl-1", changedFiles: ["b.ts"] },
        },
      ],
    });

    const verified = await verifyPlanTaskCompletionForHead({
      db,
      loopId: loop!.id,
      artifactId: planArtifact.id,
      headSha: "sha-impl-1",
    });
    expect(verified.gatePassed).toBe(true);

    const implementationArtifact = await createImplementationArtifactForHead({
      db,
      loopId: loop!.id,
      headSha: "sha-impl-1",
      loopVersion: 4,
      payload: {
        headSha: "sha-impl-1",
        summary: "All planned work implemented",
        changedFiles: ["a.ts", "b.ts"],
        completedTaskIds: ["task-1", "task-2"],
      },
      status: "accepted",
      generatedBy: "system",
    });
    const transitionResult = await transitionSdlcLoopStateWithArtifact({
      db,
      loopId: loop!.id,
      artifactId: implementationArtifact.id,
      expectedPhase: "implementing",
      transitionEvent: "implementation_completed",
      headSha: "sha-impl-1",
      loopVersion: 4,
    });
    expect(transitionResult).toBe("updated");
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
    await db
      .update(schema.sdlcLoop)
      .set({ state: "review_gate" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

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
    await db
      .update(schema.sdlcLoop)
      .set({ state: "babysitting" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

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
    expect(reloadedLoop?.state).toBe("implementing");
  });

  it("persists ci_gate as blocked origin when CI retries exhaust into blocked", async () => {
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
      currentHeadSha: "sha-ci-blocked",
    });
    await db
      .update(schema.sdlcLoop)
      .set({ state: "ci_gate", maxFixAttempts: 0, fixAttemptCount: 0 })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const result = await persistSdlcCiGateEvaluation({
      db,
      loopId: loop!.id,
      headSha: "sha-ci-blocked",
      loopVersion: 2,
      triggerEventType: "check_run.completed",
      capabilityState: "supported",
      rulesetChecks: ["tests"],
      failingChecks: ["tests"],
    });

    expect(result.status).toBe("blocked");
    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("blocked");
    expect(reloadedLoop?.blockedFromState).toBe("ci_gate");
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
    await db
      .update(schema.sdlcLoop)
      .set({ state: "babysitting" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

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
    expect(reloadedLoop?.state).toBe("implementing");
  });

  it("persists review_gate as blocked origin when deep review retries exhaust into blocked", async () => {
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
      currentHeadSha: "sha-deep-blocked",
    });
    await db
      .update(schema.sdlcLoop)
      .set({ state: "review_gate", maxFixAttempts: 0, fixAttemptCount: 0 })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const result = await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-deep-blocked",
      loopVersion: 2,
      model: "gpt-5",
      rawOutput: {
        findings: [
          {
            stableFindingId: "deep-1",
            title: "Blocking issue",
            severity: "high",
            category: "correctness",
            detail: "Needs a fix",
            suggestedFix: "Fix it",
            isBlocking: true,
          },
        ],
      },
    });

    expect(result.status).toBe("invalid_output");
    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("blocked");
    expect(reloadedLoop?.blockedFromState).toBe("review_gate");
  });

  it("does not resurrect terminal loops from gate persistence replays", async () => {
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
      currentHeadSha: "sha-terminal",
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "stopped",
        loopVersion: 10,
        currentHeadSha: "sha-terminal",
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const ciResult = await persistSdlcCiGateEvaluation({
      db,
      loopId: loop!.id,
      headSha: "sha-old",
      loopVersion: 9,
      triggerEventType: "check_run.completed",
      capabilityState: "supported",
      rulesetChecks: ["tests"],
      failingChecks: ["tests"],
    });
    expect(ciResult.loopUpdateOutcome).toBe("terminal_noop");
    expect(ciResult.shouldQueueFollowUp).toBe(false);

    const reviewResult = await persistSdlcReviewThreadGateEvaluation({
      db,
      loopId: loop!.id,
      headSha: "sha-old",
      loopVersion: 9,
      triggerEventType: "review-thread-poll-synthetic",
      evaluationSource: "polling",
      unresolvedThreadCount: 2,
    });
    expect(reviewResult.loopUpdateOutcome).toBe("terminal_noop");
    expect(reviewResult.shouldQueueFollowUp).toBe(false);

    const deepResult = await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-old",
      loopVersion: 9,
      model: "gpt-test",
      rawOutput: {
        gatePassed: false,
        blockingFindings: [
          {
            stableFindingId: "terminal-deep-1",
            title: "Replay",
            severity: "high",
            category: "state",
            detail: "Replay should not mutate terminal loops",
            suggestedFix: null,
            isBlocking: true,
          },
        ],
      },
    });
    expect(deepResult.loopUpdateOutcome).toBe("terminal_noop");
    expect(deepResult.shouldQueueFollowUp).toBe(false);

    const carmackResult = await persistCarmackReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-old",
      loopVersion: 9,
      model: "gpt-test",
      rawOutput: {
        gatePassed: false,
        blockingFindings: [
          {
            stableFindingId: "terminal-carmack-1",
            title: "Replay",
            severity: "high",
            category: "state",
            detail: "Replay should not mutate terminal loops",
            suggestedFix: null,
            isBlocking: true,
          },
        ],
      },
    });
    expect(carmackResult.loopUpdateOutcome).toBe("terminal_noop");
    expect(carmackResult.shouldQueueFollowUp).toBe(false);

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("stopped");
    expect(reloadedLoop?.loopVersion).toBe(10);
    expect(reloadedLoop?.currentHeadSha).toBe("sha-terminal");
  });

  it("treats stale gate updates as no-op when loop has moved forward", async () => {
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
      currentHeadSha: "sha-current",
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "ci_gate",
        loopVersion: 20,
        currentHeadSha: "sha-current",
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const ciResult = await persistSdlcCiGateEvaluation({
      db,
      loopId: loop!.id,
      headSha: "sha-stale",
      loopVersion: 19,
      triggerEventType: "check_run.completed",
      capabilityState: "supported",
      rulesetChecks: ["tests"],
      failingChecks: ["tests"],
    });
    expect(isStaleNoop(ciResult.loopUpdateOutcome)).toBe(true);
    expect(ciResult.shouldQueueFollowUp).toBe(false);

    const reviewResult = await persistSdlcReviewThreadGateEvaluation({
      db,
      loopId: loop!.id,
      headSha: "sha-stale",
      loopVersion: 20,
      triggerEventType: "review-thread-poll-synthetic",
      evaluationSource: "polling",
      unresolvedThreadCount: 2,
    });
    expect(isStaleNoop(reviewResult.loopUpdateOutcome)).toBe(true);
    expect(reviewResult.shouldQueueFollowUp).toBe(false);

    const deepResult = await persistDeepReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-stale",
      loopVersion: 19,
      model: "gpt-test",
      rawOutput: {
        gatePassed: false,
        blockingFindings: [
          {
            stableFindingId: "stale-deep-1",
            title: "Stale replay",
            severity: "high",
            category: "state",
            detail: "Older loop version should not move loop state",
            suggestedFix: null,
            isBlocking: true,
          },
        ],
      },
    });
    expect(isStaleNoop(deepResult.loopUpdateOutcome)).toBe(true);
    expect(deepResult.shouldQueueFollowUp).toBe(false);

    const carmackResult = await persistCarmackReviewGateResult({
      db,
      loopId: loop!.id,
      headSha: "sha-stale",
      loopVersion: 20,
      model: "gpt-test",
      rawOutput: {
        gatePassed: false,
        blockingFindings: [
          {
            stableFindingId: "stale-carmack-1",
            title: "Stale replay",
            severity: "high",
            category: "state",
            detail: "Equal version with different head should no-op",
            suggestedFix: null,
            isBlocking: true,
          },
        ],
      },
    });
    expect(isStaleNoop(carmackResult.loopUpdateOutcome)).toBe(true);
    expect(carmackResult.shouldQueueFollowUp).toBe(false);

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("ci_gate");
    expect(reloadedLoop?.loopVersion).toBe(20);
    expect(reloadedLoop?.currentHeadSha).toBe("sha-current");
  });

  it("requires loop version for implementation_progress once loop has left early states", async () => {
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
      currentHeadSha: "sha-blocked",
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "blocked",
        loopVersion: 5,
        currentHeadSha: "sha-blocked",
        fixAttemptCount: 3,
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const unversioned = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "implementation_progress",
    });
    expect(isStaleNoop(unversioned)).toBe(true);

    let reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("blocked");
    expect(reloadedLoop?.loopVersion).toBe(5);

    const versioned = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "implementation_progress",
      loopVersion: 6,
      headSha: "sha-blocked",
    });
    expect(versioned).toBe("updated");

    reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("implementing");
    expect(reloadedLoop?.loopVersion).toBe(6);
    expect(reloadedLoop?.fixAttemptCount).toBe(3);
  });

  it("does not advance planning loops on implementation_progress", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });
    expect(loop).toBeDefined();
    expect(loop?.state).toBe("planning");

    const transitionOutcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "implementation_progress",
    });

    expect(isStaleNoop(transitionOutcome)).toBe(true);

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("planning");
  });

  it("treats out-of-phase noop-style events as stale no-ops", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });

    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });
    expect(loop).toBeDefined();

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "planning",
        loopVersion: 7,
        currentHeadSha: "sha-planning",
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const outOfPhaseEvents = [
      "deep_review_gate_passed",
      "carmack_review_gate_passed",
      "video_capture_started",
    ] as const;

    for (const transitionEvent of outOfPhaseEvents) {
      const outcome = await transitionSdlcLoopState({
        db,
        loopId: loop!.id,
        transitionEvent,
        headSha: "sha-out-of-phase",
        loopVersion: 8,
      });
      expect(isStaleNoop(outcome)).toBe(true);
    }

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("planning");
    expect(reloadedLoop?.loopVersion).toBe(7);
    expect(reloadedLoop?.currentHeadSha).toBe("sha-planning");
  });

  it("escalates to human feedback when retry cap is exceeded", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "review_gate",
        fixAttemptCount: 1,
        maxFixAttempts: 1,
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const transitionOutcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "review_blocked",
    });
    expect(transitionOutcome).toBe("updated");

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.state).toBe("blocked");
    expect(reloadedLoop?.fixAttemptCount).toBe(2);
    expect(reloadedLoop?.maxFixAttempts).toBe(1);
  });

  it("resumes blocked loop back to implementing", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "blocked",
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const outcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "blocked_resume_requested",
    });
    expect(outcome).toBe("updated");

    const reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("implementing");
    expect(reloaded?.fixAttemptCount).toBe(0);
  });

  it("supports one-time bypass transition from blocked state", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "blocked",
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const outcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "blocked_bypass_once_requested",
    });
    expect(outcome).toBe("updated");

    const reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("implementing");
  });

  it("preserves fix attempt count on implementing→review_gate (fix cycle return)", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "implementing",
        fixAttemptCount: 3,
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const outcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "implementation_completed",
    });
    expect(outcome).toBe("updated");

    const reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("review_gate");
    expect(reloaded?.fixAttemptCount).toBe(3);
  });

  it("blocks loop when fix attempts exceed maxFixAttempts", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    // Simulate: review_gate with fixAttemptCount at maxFixAttempts
    await db
      .update(schema.sdlcLoop)
      .set({
        state: "review_gate",
        fixAttemptCount: 6,
        maxFixAttempts: 6,
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    // Next review_blocked should trigger exhausted_retryable_failure → blocked
    const outcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "review_blocked",
    });
    expect(outcome).toBe("updated");

    const reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("blocked");
  });

  it("resets fix attempts when UI smoke passes without a PR link", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "ui_gate",
        fixAttemptCount: 3,
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const outcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "ui_smoke_passed",
    });
    expect(outcome).toBe("updated");

    const reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("awaiting_pr_link");
    expect(reloaded?.fixAttemptCount).toBe(0);
  });

  it("resets fix attempts when promoting awaiting_pr_link to babysitting", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "awaiting_pr_link",
        fixAttemptCount: 2,
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const outcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "pr_linked",
    });
    expect(outcome).toBe("updated");

    const reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("babysitting");
    expect(reloaded?.fixAttemptCount).toBe(0);
  });

  it("does not reset fix attempts when failing back to implementing", async () => {
    const { user } = await createTestUser({ db });
    const { threadId } = await createTestThread({
      db,
      userId: user.id,
      overrides: {
        githubRepoFullName: "owner/repo",
      },
    });
    const loop = await enrollSdlcLoopForThread({
      db,
      userId: user.id,
      repoFullName: "owner/repo",
      threadId,
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "review_gate",
        fixAttemptCount: 2,
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const outcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "review_blocked",
    });
    expect(outcome).toBe("updated");

    const reloaded = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloaded?.state).toBe("implementing");
    expect(reloaded?.fixAttemptCount).toBe(3);
  });

  it("does not rewrite current head sha on unversioned implementation transitions", async () => {
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
      currentHeadSha: "sha-stable",
    });

    await db
      .update(schema.sdlcLoop)
      .set({
        state: "implementing",
        loopVersion: 3,
        currentHeadSha: "sha-stable",
      })
      .where(eq(schema.sdlcLoop.id, loop!.id));

    const outcome = await transitionSdlcLoopState({
      db,
      loopId: loop!.id,
      transitionEvent: "implementation_progress",
      headSha: "sha-ignored",
    });
    expect(outcome).toBe("updated");

    const reloadedLoop = await db.query.sdlcLoop.findFirst({
      where: eq(schema.sdlcLoop.id, loop!.id),
    });
    expect(reloadedLoop?.currentHeadSha).toBe("sha-stable");
    expect(reloadedLoop?.loopVersion).toBe(3);
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
    await db
      .update(schema.sdlcLoop)
      .set({ state: "review_gate" })
      .where(eq(schema.sdlcLoop.id, loop!.id));

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
    expect(reloadedLoop?.state).toBe("implementing");
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
});
