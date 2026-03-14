import { DB } from "../../db";
import * as schema from "../../db/schema";
import type {
  SdlcCiCapabilityState,
  SdlcCiGateStatus,
  SdlcCiRequiredCheckSource,
} from "../../db/types";
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
  now?: Date;
}): Promise<PersistSdlcCiGateEvaluationResult> {
  return await db.transaction(async (tx) => {
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
