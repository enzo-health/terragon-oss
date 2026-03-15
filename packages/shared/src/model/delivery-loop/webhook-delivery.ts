import { and, eq, isNull, lte } from "drizzle-orm";
import { DB } from "../../db";
import * as schema from "../../db/schema";

export const GITHUB_WEBHOOK_CLAIM_TTL_MS = 5 * 60 * 1000;

export type GithubWebhookDeliveryClaimOutcome =
  | "claimed_new"
  | "already_completed"
  | "in_progress_fresh"
  | "stale_stolen";

export type GithubWebhookDeliveryClaimResult = {
  outcome: GithubWebhookDeliveryClaimOutcome;
  shouldProcess: boolean;
};

export function getGithubWebhookClaimHttpStatus(
  outcome: GithubWebhookDeliveryClaimOutcome,
): number {
  switch (outcome) {
    case "already_completed":
      return 200;
    case "claimed_new":
    case "stale_stolen":
    case "in_progress_fresh":
      return 202;
    default: {
      const _exhaustive: never = outcome;
      throw new Error(`Unhandled GitHub claim outcome: ${_exhaustive}`);
    }
  }
}

export async function claimGithubWebhookDelivery({
  db,
  deliveryId,
  claimantToken,
  eventType,
  now = new Date(),
}: {
  db: DB;
  deliveryId: string;
  claimantToken: string;
  eventType?: string;
  now?: Date;
}): Promise<GithubWebhookDeliveryClaimResult> {
  const claimExpiresAt = new Date(now.getTime() + GITHUB_WEBHOOK_CLAIM_TTL_MS);

  const inserted = await db
    .insert(schema.githubWebhookDeliveries)
    .values({
      deliveryId,
      claimantToken,
      claimExpiresAt,
      eventType: eventType ?? null,
    })
    .onConflictDoNothing()
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  if (inserted.length > 0) {
    return { outcome: "claimed_new", shouldProcess: true };
  }

  const existing = await db.query.githubWebhookDeliveries.findFirst({
    where: eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
  });

  if (!existing) {
    return { outcome: "in_progress_fresh", shouldProcess: false };
  }

  if (existing.completedAt) {
    return { outcome: "already_completed", shouldProcess: false };
  }

  if (existing.claimExpiresAt > now) {
    return { outcome: "in_progress_fresh", shouldProcess: false };
  }

  const stolen = await db
    .update(schema.githubWebhookDeliveries)
    .set({
      claimantToken,
      claimExpiresAt,
      eventType: eventType ?? existing.eventType,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
        isNull(schema.githubWebhookDeliveries.completedAt),
        lte(schema.githubWebhookDeliveries.claimExpiresAt, now),
      ),
    )
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  if (stolen.length > 0) {
    return { outcome: "stale_stolen", shouldProcess: true };
  }

  const raced = await db.query.githubWebhookDeliveries.findFirst({
    where: eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
  });

  if (raced?.completedAt) {
    return { outcome: "already_completed", shouldProcess: false };
  }

  return { outcome: "in_progress_fresh", shouldProcess: false };
}

export async function completeGithubWebhookDelivery({
  db,
  deliveryId,
  claimantToken,
  completedAt = new Date(),
}: {
  db: DB;
  deliveryId: string;
  claimantToken: string;
  completedAt?: Date;
}): Promise<boolean> {
  const updated = await db
    .update(schema.githubWebhookDeliveries)
    .set({
      completedAt,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
        eq(schema.githubWebhookDeliveries.claimantToken, claimantToken),
        isNull(schema.githubWebhookDeliveries.completedAt),
      ),
    )
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  return updated.length > 0;
}

export async function releaseGithubWebhookDeliveryClaim({
  db,
  deliveryId,
  claimantToken,
  releasedAt = new Date(),
}: {
  db: DB;
  deliveryId: string;
  claimantToken: string;
  releasedAt?: Date;
}): Promise<boolean> {
  const updated = await db
    .update(schema.githubWebhookDeliveries)
    .set({
      claimExpiresAt: releasedAt,
      updatedAt: releasedAt,
    })
    .where(
      and(
        eq(schema.githubWebhookDeliveries.deliveryId, deliveryId),
        eq(schema.githubWebhookDeliveries.claimantToken, claimantToken),
        isNull(schema.githubWebhookDeliveries.completedAt),
      ),
    )
    .returning({ deliveryId: schema.githubWebhookDeliveries.deliveryId });

  return updated.length > 0;
}
