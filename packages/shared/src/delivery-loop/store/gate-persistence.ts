import { and, eq, isNull, type InferSelectModel } from "drizzle-orm";
import * as z from "zod/v4";
import { DB } from "../../db";
import * as schema from "../../db/schema";

// ---------------------------------------------------------------------------
// Zod schemas
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

// Backwards-compatible aliases used by deep-review-gate.ts and carmack-review-gate.ts
export const deepReviewFindingSchema = reviewFindingSchema;
export const deepReviewGateOutputSchema = reviewGateOutputSchema;
export const carmackReviewFindingSchema = reviewFindingSchema;
export const carmackReviewGateOutputSchema = reviewGateOutputSchema;

export type DeepReviewGateOutput = ReviewGateOutput;
export type CarmackReviewGateOutput = ReviewGateOutput;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export async function getUnresolvedBlockingDeepReviewFindings(args: {
  db: DB;
  loopId: string;
  headSha: string;
}): Promise<InferSelectModel<typeof schema.deliveryDeepReviewFinding>[]> {
  const { db, loopId, headSha } = args;
  return db.query.deliveryDeepReviewFinding.findMany({
    where: and(
      eq(schema.deliveryDeepReviewFinding.loopId, loopId),
      eq(schema.deliveryDeepReviewFinding.headSha, headSha),
      eq(schema.deliveryDeepReviewFinding.isBlocking, true),
      isNull(schema.deliveryDeepReviewFinding.resolvedAt),
    ),
    orderBy: [schema.deliveryDeepReviewFinding.createdAt],
  });
}

export async function getUnresolvedBlockingCarmackReviewFindings(args: {
  db: DB;
  loopId: string;
  headSha: string;
}): Promise<InferSelectModel<typeof schema.deliveryCarmackReviewFinding>[]> {
  const { db, loopId, headSha } = args;
  return db.query.deliveryCarmackReviewFinding.findMany({
    where: and(
      eq(schema.deliveryCarmackReviewFinding.loopId, loopId),
      eq(schema.deliveryCarmackReviewFinding.headSha, headSha),
      eq(schema.deliveryCarmackReviewFinding.isBlocking, true),
      isNull(schema.deliveryCarmackReviewFinding.resolvedAt),
    ),
    orderBy: [schema.deliveryCarmackReviewFinding.createdAt],
  });
}
