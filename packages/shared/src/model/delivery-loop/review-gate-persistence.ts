import { createHash } from "node:crypto";
import {
  and,
  eq,
  isNull,
  notInArray,
  type InferSelectModel,
} from "drizzle-orm";
import * as z from "zod/v4";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type {
  SdlcDeepReviewSeverity,
  SdlcDeepReviewStatus,
  SdlcCarmackReviewSeverity,
  SdlcCarmackReviewStatus,
} from "../../db/types";
import type { SdlcLoopTransitionEvent } from "./state-constants";
import type { SdlcGateLoopUpdateOutcome } from "./guarded-state";
import { persistGuardedGateLoopState } from "./guarded-state";

// ---------------------------------------------------------------------------
// ReviewGateTableBinding — parameterises the deep/carmack review gate
// ---------------------------------------------------------------------------

interface ReviewGateTableBinding {
  readonly runTable:
    | typeof schema.sdlcDeepReviewRun
    | typeof schema.sdlcCarmackReviewRun;
  readonly findingTable:
    | typeof schema.sdlcDeepReviewFinding
    | typeof schema.sdlcCarmackReviewFinding;
  readonly stableIdPrefix: string;
  readonly invalidOutputErrorCode: string;
  readonly label: string;
  readonly blockedEvent: SdlcLoopTransitionEvent;
  readonly passedEvent: SdlcLoopTransitionEvent;
}

const DEEP_REVIEW_BINDING: ReviewGateTableBinding = {
  runTable: schema.sdlcDeepReviewRun,
  findingTable: schema.sdlcDeepReviewFinding,
  stableIdPrefix: "deep_review_",
  invalidOutputErrorCode: "deep_review_invalid_output",
  label: "deep review",
  blockedEvent: "deep_review_gate_blocked",
  passedEvent: "deep_review_gate_passed",
};

const CARMACK_REVIEW_BINDING: ReviewGateTableBinding = {
  runTable: schema.sdlcCarmackReviewRun,
  findingTable: schema.sdlcCarmackReviewFinding,
  stableIdPrefix: "carmack_review_",
  invalidOutputErrorCode: "carmack_review_invalid_output",
  label: "carmack review",
  blockedEvent: "carmack_review_gate_blocked",
  passedEvent: "carmack_review_gate_passed",
};

// ---------------------------------------------------------------------------
// Shared schemas & types
// ---------------------------------------------------------------------------

const reviewSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

export const reviewFindingSchema = z.object({
  stableFindingId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  severity: reviewSeveritySchema,
  category: z.string().trim().min(1),
  detail: z.string().trim().min(1),
  suggestedFix: z.string().trim().min(1).nullable().optional(),
  isBlocking: z.boolean().optional().default(true),
});

export const reviewGateOutputSchema = z.object({
  gatePassed: z.boolean(),
  blockingFindings: z.array(reviewFindingSchema),
});

export type ReviewGateOutput = z.infer<typeof reviewGateOutputSchema>;

type NormalizedReviewFinding = {
  stableFindingId: string;
  title: string;
  severity: SdlcDeepReviewSeverity | SdlcCarmackReviewSeverity;
  category: string;
  detail: string;
  suggestedFix: string | null;
  isBlocking: boolean;
};

export type PersistReviewGateResult = {
  runId: string;
  status: SdlcDeepReviewStatus | SdlcCarmackReviewStatus;
  gatePassed: boolean;
  invalidOutput: boolean;
  errorCode: string | null;
  unresolvedBlockingFindings: number;
  shouldQueueFollowUp: boolean;
  loopUpdateOutcome: SdlcGateLoopUpdateOutcome;
  findings: NormalizedReviewFinding[];
};

// Backwards-compatible type aliases
export type DeepReviewGateOutput = ReviewGateOutput;
export type CarmackReviewGateOutput = ReviewGateOutput;
export type PersistDeepReviewGateResult = PersistReviewGateResult;
export type PersistCarmackReviewGateResult = PersistReviewGateResult;

// Backwards-compatible schema aliases
export const deepReviewFindingSchema = reviewFindingSchema;
export const deepReviewGateOutputSchema = reviewGateOutputSchema;
export const carmackReviewFindingSchema = reviewFindingSchema;
export const carmackReviewGateOutputSchema = reviewGateOutputSchema;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function buildReviewFindingStableId(
  stableIdPrefix: string,
  finding: z.infer<typeof reviewFindingSchema>,
): string {
  if (finding.stableFindingId?.trim()) {
    return finding.stableFindingId.trim();
  }

  const canonical = [
    finding.title.trim().toLowerCase(),
    finding.severity,
    finding.category.trim().toLowerCase(),
    finding.detail.trim().toLowerCase(),
  ].join("|");

  return `${stableIdPrefix}${createHash("sha256").update(canonical).digest("hex").slice(0, 24)}`;
}

function normalizeReviewFindings(
  stableIdPrefix: string,
  findings: z.infer<typeof reviewFindingSchema>[],
): NormalizedReviewFinding[] {
  const deduped = new Map<string, NormalizedReviewFinding>();

  for (const finding of findings) {
    const stableFindingId = buildReviewFindingStableId(stableIdPrefix, finding);
    if (deduped.has(stableFindingId)) {
      continue;
    }
    deduped.set(stableFindingId, {
      stableFindingId,
      title: finding.title.trim(),
      severity: finding.severity,
      category: finding.category.trim(),
      detail: finding.detail.trim(),
      suggestedFix: finding.suggestedFix?.trim() || null,
      isBlocking: finding.isBlocking,
    });
  }

  return [...deduped.values()];
}

type ReviewGateParseResult =
  | { ok: true; output: ReviewGateOutput }
  | {
      ok: false;
      errorCode: string;
      errorDetails: string[];
    };

export function parseReviewGateOutput(
  rawOutput: unknown,
  invalidOutputErrorCode: string,
): ReviewGateParseResult {
  const parsed = reviewGateOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: invalidOutputErrorCode,
      errorDetails: parsed.error.issues.map((issue) => issue.message),
    };
  }
  return { ok: true, output: parsed.data };
}

// Backwards-compatible parse functions
export function parseDeepReviewGateOutput(rawOutput: unknown) {
  return parseReviewGateOutput(
    rawOutput,
    DEEP_REVIEW_BINDING.invalidOutputErrorCode,
  );
}

export function parseCarmackReviewGateOutput(rawOutput: unknown) {
  return parseReviewGateOutput(
    rawOutput,
    CARMACK_REVIEW_BINDING.invalidOutputErrorCode,
  );
}

// ---------------------------------------------------------------------------
// Unified persistence
// ---------------------------------------------------------------------------

async function persistReviewGateResult({
  binding,
  db,
  loopId,
  headSha,
  loopVersion,
  model,
  rawOutput,
  promptVersion = 1,
  updateLoopState = true,
}: {
  binding: ReviewGateTableBinding;
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  model: string;
  rawOutput: unknown;
  promptVersion?: number;
  updateLoopState?: boolean;
}): Promise<PersistReviewGateResult> {
  return await db.transaction(async (tx) => {
    const parsed = parseReviewGateOutput(
      rawOutput,
      binding.invalidOutputErrorCode,
    );

    if (!parsed.ok) {
      const [run] = await (tx as any)
        .insert(binding.runTable)
        .values({
          loopId,
          headSha,
          loopVersion,
          status: "invalid_output",
          gatePassed: false,
          invalidOutput: true,
          model,
          promptVersion,
          rawOutput,
          errorCode: parsed.errorCode,
        })
        .onConflictDoUpdate({
          target: [
            (binding.runTable as any).loopId,
            (binding.runTable as any).headSha,
          ],
          set: {
            loopVersion,
            status: "invalid_output",
            gatePassed: false,
            invalidOutput: true,
            model,
            promptVersion,
            rawOutput,
            errorCode: parsed.errorCode,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!run) {
        throw new Error(
          `Failed to persist invalid-output ${binding.label} run`,
        );
      }

      await (tx as any)
        .delete(binding.findingTable)
        .where(
          and(
            eq((binding.findingTable as any).loopId, loopId),
            eq((binding.findingTable as any).headSha, headSha),
          ),
        );

      const loopUpdateOutcome = updateLoopState
        ? await persistGuardedGateLoopState({
            tx,
            loopId,
            headSha,
            loopVersion,
            transitionEvent: binding.blockedEvent,
            blockedFromState: "review_gate",
            now: new Date(),
          })
        : "stale_noop";

      return {
        runId: run.id,
        status: "invalid_output" as any,
        gatePassed: false,
        invalidOutput: true,
        errorCode: parsed.errorCode,
        unresolvedBlockingFindings: 0,
        shouldQueueFollowUp: false,
        loopUpdateOutcome,
        findings: [],
      };
    }

    const findings = normalizeReviewFindings(
      binding.stableIdPrefix,
      parsed.output.blockingFindings,
    );
    const blockingFindings = findings.filter((finding) => finding.isBlocking);
    const gatePassed =
      parsed.output.gatePassed && blockingFindings.length === 0;
    const status = gatePassed ? "passed" : "blocked";

    const [run] = await (tx as any)
      .insert(binding.runTable)
      .values({
        loopId,
        headSha,
        loopVersion,
        status,
        gatePassed,
        invalidOutput: false,
        model,
        promptVersion,
        rawOutput,
        errorCode: null,
      })
      .onConflictDoUpdate({
        target: [
          (binding.runTable as any).loopId,
          (binding.runTable as any).headSha,
        ],
        set: {
          loopVersion,
          status,
          gatePassed,
          invalidOutput: false,
          model,
          promptVersion,
          rawOutput,
          errorCode: null,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!run) {
      throw new Error(`Failed to persist ${binding.label} run`);
    }

    if (findings.length === 0) {
      await (tx as any)
        .delete(binding.findingTable)
        .where(
          and(
            eq((binding.findingTable as any).loopId, loopId),
            eq((binding.findingTable as any).headSha, headSha),
          ),
        );
    } else {
      const stableFindingIds = findings.map(
        (finding) => finding.stableFindingId,
      );
      await (tx as any)
        .delete(binding.findingTable)
        .where(
          and(
            eq((binding.findingTable as any).loopId, loopId),
            eq((binding.findingTable as any).headSha, headSha),
            notInArray(
              (binding.findingTable as any).stableFindingId,
              stableFindingIds,
            ),
          ),
        );

      for (const finding of findings) {
        await (tx as any)
          .insert(binding.findingTable)
          .values({
            reviewRunId: run.id,
            loopId,
            headSha,
            stableFindingId: finding.stableFindingId,
            title: finding.title,
            severity: finding.severity,
            category: finding.category,
            detail: finding.detail,
            suggestedFix: finding.suggestedFix,
            isBlocking: finding.isBlocking,
          })
          .onConflictDoUpdate({
            target: [
              (binding.findingTable as any).loopId,
              (binding.findingTable as any).headSha,
              (binding.findingTable as any).stableFindingId,
            ],
            set: {
              reviewRunId: run.id,
              title: finding.title,
              severity: finding.severity,
              category: finding.category,
              detail: finding.detail,
              suggestedFix: finding.suggestedFix,
              isBlocking: finding.isBlocking,
              resolvedAt: null,
              resolvedByEventId: null,
              updatedAt: new Date(),
            },
          });
      }
    }

    const loopUpdateOutcome = updateLoopState
      ? await persistGuardedGateLoopState({
          tx,
          loopId,
          headSha,
          loopVersion,
          transitionEvent:
            status === "blocked" ? binding.blockedEvent : binding.passedEvent,
          blockedFromState: status === "blocked" ? "review_gate" : null,
          now: new Date(),
        })
      : "stale_noop";

    const unresolvedBlockingFindings = (
      await (tx as any)
        .select({ id: (binding.findingTable as any).id })
        .from(binding.findingTable)
        .where(
          and(
            eq((binding.findingTable as any).loopId, loopId),
            eq((binding.findingTable as any).headSha, headSha),
            eq((binding.findingTable as any).isBlocking, true),
            isNull((binding.findingTable as any).resolvedAt),
          ),
        )
    ).length;

    return {
      runId: run.id,
      status: status as any,
      gatePassed,
      invalidOutput: false,
      errorCode: null,
      unresolvedBlockingFindings,
      shouldQueueFollowUp:
        loopUpdateOutcome === "updated" && unresolvedBlockingFindings > 0,
      loopUpdateOutcome,
      findings,
    };
  });
}

// ---------------------------------------------------------------------------
// Unified query helpers
// ---------------------------------------------------------------------------

async function getUnresolvedBlockingReviewFindings({
  binding,
  db,
  loopId,
  headSha,
}: {
  binding: ReviewGateTableBinding;
  db: DB;
  loopId: string;
  headSha: string;
}) {
  return await (db as any).query[
    binding.findingTable === schema.sdlcDeepReviewFinding
      ? "sdlcDeepReviewFinding"
      : "sdlcCarmackReviewFinding"
  ].findMany({
    where: and(
      eq((binding.findingTable as any).loopId, loopId),
      eq((binding.findingTable as any).headSha, headSha),
      eq((binding.findingTable as any).isBlocking, true),
      isNull((binding.findingTable as any).resolvedAt),
    ),
    orderBy: [(binding.findingTable as any).createdAt],
  });
}

async function resolveReviewFinding({
  binding,
  db,
  loopId,
  headSha,
  stableFindingId,
  resolvedByEventId,
}: {
  binding: ReviewGateTableBinding;
  db: DB;
  loopId: string;
  headSha: string;
  stableFindingId: string;
  resolvedByEventId: string;
}) {
  const [finding] = await (db as any)
    .update(binding.findingTable)
    .set({
      resolvedAt: new Date(),
      resolvedByEventId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq((binding.findingTable as any).loopId, loopId),
        eq((binding.findingTable as any).headSha, headSha),
        eq((binding.findingTable as any).stableFindingId, stableFindingId),
      ),
    )
    .returning();

  return finding;
}

async function shouldQueueFollowUpForReview({
  binding,
  db,
  loopId,
  headSha,
}: {
  binding: ReviewGateTableBinding;
  db: DB;
  loopId: string;
  headSha: string;
}) {
  const unresolved = await getUnresolvedBlockingReviewFindings({
    binding,
    db,
    loopId,
    headSha,
  });
  return unresolved.length > 0;
}

// ---------------------------------------------------------------------------
// Backwards-compatible named wrappers — deep review
// ---------------------------------------------------------------------------

export async function persistDeepReviewGateResult(args: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  model: string;
  rawOutput: unknown;
  promptVersion?: number;
  updateLoopState?: boolean;
}): Promise<PersistDeepReviewGateResult> {
  return persistReviewGateResult({ ...args, binding: DEEP_REVIEW_BINDING });
}

export async function getUnresolvedBlockingDeepReviewFindings(args: {
  db: DB;
  loopId: string;
  headSha: string;
}): Promise<InferSelectModel<typeof schema.sdlcDeepReviewFinding>[]> {
  return getUnresolvedBlockingReviewFindings({
    ...args,
    binding: DEEP_REVIEW_BINDING,
  });
}

export async function resolveDeepReviewFinding(args: {
  db: DB;
  loopId: string;
  headSha: string;
  stableFindingId: string;
  resolvedByEventId: string;
}) {
  return resolveReviewFinding({ ...args, binding: DEEP_REVIEW_BINDING });
}

export async function shouldQueueFollowUpForDeepReview(args: {
  db: DB;
  loopId: string;
  headSha: string;
}) {
  return shouldQueueFollowUpForReview({
    ...args,
    binding: DEEP_REVIEW_BINDING,
  });
}

// ---------------------------------------------------------------------------
// Backwards-compatible named wrappers — carmack review
// ---------------------------------------------------------------------------

export async function persistCarmackReviewGateResult(args: {
  db: DB;
  loopId: string;
  headSha: string;
  loopVersion: number;
  model: string;
  rawOutput: unknown;
  promptVersion?: number;
  updateLoopState?: boolean;
}): Promise<PersistCarmackReviewGateResult> {
  return persistReviewGateResult({ ...args, binding: CARMACK_REVIEW_BINDING });
}

export async function getUnresolvedBlockingCarmackReviewFindings(args: {
  db: DB;
  loopId: string;
  headSha: string;
}): Promise<InferSelectModel<typeof schema.sdlcCarmackReviewFinding>[]> {
  return getUnresolvedBlockingReviewFindings({
    ...args,
    binding: CARMACK_REVIEW_BINDING,
  });
}

export async function resolveCarmackReviewFinding(args: {
  db: DB;
  loopId: string;
  headSha: string;
  stableFindingId: string;
  resolvedByEventId: string;
}) {
  return resolveReviewFinding({ ...args, binding: CARMACK_REVIEW_BINDING });
}

export async function shouldQueueFollowUpForCarmackReview(args: {
  db: DB;
  loopId: string;
  headSha: string;
}) {
  return shouldQueueFollowUpForReview({
    ...args,
    binding: CARMACK_REVIEW_BINDING,
  });
}

// ---------------------------------------------------------------------------
// Carmack-specific: check deep review passed first
// ---------------------------------------------------------------------------

export async function canRunCarmackReviewForHeadSha({
  db,
  loopId,
  headSha,
}: {
  db: DB;
  loopId: string;
  headSha: string;
}) {
  const deepReviewRun = await db.query.sdlcDeepReviewRun.findFirst({
    where: and(
      eq(schema.sdlcDeepReviewRun.loopId, loopId),
      eq(schema.sdlcDeepReviewRun.headSha, headSha),
    ),
    orderBy: [schema.sdlcDeepReviewRun.updatedAt],
  });

  return Boolean(
    deepReviewRun?.gatePassed && deepReviewRun.status === "passed",
  );
}
