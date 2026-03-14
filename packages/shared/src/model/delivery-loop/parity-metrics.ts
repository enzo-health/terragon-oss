import { and, eq, gte, lte, sql } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";
import type { SdlcLoopCauseType, SdlcParityTargetClass } from "../../db/types";

export async function recordSdlcParityMetricSample({
  db,
  causeType,
  targetClass,
  matched,
  eligible = true,
  observedAt = new Date(),
}: {
  db: DB;
  causeType: SdlcLoopCauseType;
  targetClass: SdlcParityTargetClass;
  matched: boolean;
  eligible?: boolean;
  observedAt?: Date;
}) {
  const [sample] = await db
    .insert(schema.sdlcParityMetricSample)
    .values({
      causeType,
      targetClass,
      matched,
      eligible,
      observedAt,
    })
    .returning();

  return sample;
}

export type SdlcParityBucketStats = {
  causeType: SdlcLoopCauseType;
  targetClass: SdlcParityTargetClass;
  eligibleCount: number;
  matchedCount: number;
  parity: number;
};

export async function getSdlcParityBucketStats({
  db,
  windowStart,
  windowEnd,
}: {
  db: DB;
  windowStart: Date;
  windowEnd: Date;
}): Promise<SdlcParityBucketStats[]> {
  const grouped = await db
    .select({
      causeType: schema.sdlcParityMetricSample.causeType,
      targetClass: schema.sdlcParityMetricSample.targetClass,
      eligibleCount: sql<number>`count(*)`,
      matchedCount: sql<number>`sum(case when ${schema.sdlcParityMetricSample.matched} then 1 else 0 end)`,
    })
    .from(schema.sdlcParityMetricSample)
    .where(
      and(
        eq(schema.sdlcParityMetricSample.eligible, true),
        gte(schema.sdlcParityMetricSample.observedAt, windowStart),
        lte(schema.sdlcParityMetricSample.observedAt, windowEnd),
      ),
    )
    .groupBy(
      schema.sdlcParityMetricSample.causeType,
      schema.sdlcParityMetricSample.targetClass,
    );

  return grouped.map((row) => {
    const eligibleCount = Number(row.eligibleCount ?? 0);
    const matchedCount = Number(row.matchedCount ?? 0);
    const parity = eligibleCount === 0 ? 1 : matchedCount / eligibleCount;

    return {
      causeType: row.causeType,
      targetClass: row.targetClass,
      eligibleCount,
      matchedCount,
      parity,
    };
  });
}

export function evaluateSdlcParitySlo({
  bucketStats,
  criticalInvariantViolation,
  cutoverThreshold = 0.999,
  rollbackThreshold = 0.99,
}: {
  bucketStats: SdlcParityBucketStats[];
  criticalInvariantViolation: boolean;
  cutoverThreshold?: number;
  rollbackThreshold?: number;
}) {
  const failingCutoverBuckets = bucketStats.filter(
    (bucket) => bucket.eligibleCount === 0 || bucket.parity < cutoverThreshold,
  );
  const failingRollbackBuckets = bucketStats.filter(
    (bucket) => bucket.eligibleCount > 0 && bucket.parity < rollbackThreshold,
  );

  return {
    cutoverEligible:
      bucketStats.length > 0 &&
      failingCutoverBuckets.length === 0 &&
      !criticalInvariantViolation,
    rollbackRequired:
      criticalInvariantViolation || failingRollbackBuckets.length > 0,
    failingCutoverBuckets,
    failingRollbackBuckets,
  };
}
