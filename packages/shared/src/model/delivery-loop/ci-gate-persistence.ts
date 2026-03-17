import { eq } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type {
  SdlcCiCapabilityState,
  SdlcCiGateStatus,
  SdlcCiRequiredCheckSource,
} from "../../db/types";
import type { GateVerdict } from "../../delivery-loop/domain/events";
import type { GitSha } from "../../delivery-loop/domain/workflow";
import type { SdlcGateLoopUpdateOutcome } from "./guarded-state";
import {
  persistGuardedGateLoopState,
  normalizeCheckNames,
  resolveRequiredCheckSource,
} from "./guarded-state";

export type PersistSdlcCiGateEvaluationResult = {
  runId: string;
  status: SdlcCiGateStatus;
  gatePassed: boolean;
  requiredCheckSource: SdlcCiRequiredCheckSource;
  requiredChecks: string[];
  failingRequiredChecks: string[];
  shouldQueueFollowUp: boolean;
  loopUpdateOutcome: SdlcGateLoopUpdateOutcome;
};

/** Convert a CI gate persistence result to a v2 GateVerdict */
export function toCiGateVerdict(
  result: PersistSdlcCiGateEvaluationResult,
  headSha: string,
  loopVersion: number,
): GateVerdict {
  return {
    gate: "ci",
    passed: result.gatePassed,
    event: result.gatePassed ? "gate_passed" : "gate_blocked",
    runId: result.runId,
    headSha: headSha as GitSha,
    loopVersion,
    findingCount: result.failingRequiredChecks.length,
  };
}

export async function persistSdlcCiGateEvaluation({
  db,
  loopId,
  headSha,
  loopVersion,
  triggerEventType,
  capabilityState,
  rulesetChecks = [],
  branchProtectionChecks = [],
  allowlistChecks = [],
  failingChecks = [],
  provenance,
  normalizationVersion = 1,
  idempotencyKey,
  now = new Date(),
}: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  triggerEventType: "check_run.completed" | "check_suite.completed";
  capabilityState: SdlcCiCapabilityState;
  rulesetChecks?: string[];
  branchProtectionChecks?: string[];
  allowlistChecks?: string[];
  failingChecks?: string[];
  provenance?: Record<string, unknown>;
  normalizationVersion?: number;
  idempotencyKey?: string;
  now?: Date;
}): Promise<PersistSdlcCiGateEvaluationResult> {
  return await db.transaction(async (tx) => {
    if (idempotencyKey) {
      const existing = await tx.query.sdlcCiGateRun.findFirst({
        where: eq(schema.sdlcCiGateRun.idempotencyKey, idempotencyKey),
      });
      if (existing) {
        return {
          runId: existing.id,
          status: existing.status,
          gatePassed: existing.gatePassed,
          requiredCheckSource: existing.requiredCheckSource,
          requiredChecks: existing.requiredChecks ?? [],
          failingRequiredChecks: existing.failingRequiredChecks ?? [],
          shouldQueueFollowUp: false,
          loopUpdateOutcome: "updated",
        };
      }
    }

    const normalizedRuleset = normalizeCheckNames(rulesetChecks);
    const normalizedBranchProtection = normalizeCheckNames(
      branchProtectionChecks,
    );
    const normalizedAllowlist = normalizeCheckNames(allowlistChecks);
    const normalizedFailing = normalizeCheckNames(failingChecks);

    const { source, requiredChecks } = resolveRequiredCheckSource({
      rulesetChecks: normalizedRuleset,
      branchProtectionChecks: normalizedBranchProtection,
      allowlistChecks: normalizedAllowlist,
    });

    const relevantFailingChecks = normalizedFailing.filter((check) =>
      requiredChecks.includes(check),
    );

    const hasCapabilityError = capabilityState !== "supported";
    const gatePassed =
      !hasCapabilityError &&
      (requiredChecks.length === 0 || relevantFailingChecks.length === 0);
    const status: SdlcCiGateStatus = hasCapabilityError
      ? "capability_error"
      : gatePassed
        ? "passed"
        : "blocked";

    const [run] = await tx
      .insert(schema.sdlcCiGateRun)
      .values({
        loopId,
        headSha,
        loopVersion,
        status,
        gatePassed,
        actorType: "installation_app",
        capabilityState,
        requiredCheckSource: source,
        requiredChecks,
        failingRequiredChecks: relevantFailingChecks,
        provenance: provenance ?? null,
        normalizationVersion,
        triggerEventType,
        errorCode: hasCapabilityError
          ? `ci_capability_${capabilityState}`
          : null,
        idempotencyKey: idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.sdlcCiGateRun.loopId, schema.sdlcCiGateRun.headSha],
        set: {
          loopVersion,
          status,
          gatePassed,
          actorType: "installation_app",
          capabilityState,
          requiredCheckSource: source,
          requiredChecks,
          failingRequiredChecks: relevantFailingChecks,
          provenance: provenance ?? null,
          normalizationVersion,
          triggerEventType,
          errorCode: hasCapabilityError
            ? `ci_capability_${capabilityState}`
            : null,
          idempotencyKey: idempotencyKey ?? null,
          updatedAt: now,
        },
      })
      .returning({ id: schema.sdlcCiGateRun.id });

    if (!run) {
      throw new Error("Failed to persist CI gate run");
    }

    const loopUpdateOutcome = await persistGuardedGateLoopState({
      tx,
      loopId,
      headSha,
      loopVersion,
      transitionEvent: gatePassed ? "ci_gate_passed" : "ci_gate_blocked",
      blockedFromState: gatePassed ? null : "ci_gate",
      now,
    });

    return {
      runId: run.id,
      status,
      gatePassed,
      requiredCheckSource: source,
      requiredChecks,
      failingRequiredChecks: relevantFailingChecks,
      shouldQueueFollowUp: !gatePassed && loopUpdateOutcome === "updated",
      loopUpdateOutcome,
    };
  });
}
