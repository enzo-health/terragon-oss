import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb } from "../db";
import * as schema from "../db/schema";
import { env } from "@leo/env/pkg-shared";
import { createTestUser } from "./test-helpers";
import {
  getUserCreditBalance,
  grantUserCredits,
  updateUsageEventsAggCacheForUser,
  decimalValueToCents,
  usdNumberToCents,
  sumAggregatedUsageCents,
} from "./credits";
import { trackUsageEventBatched } from "./usage-events";
import {
  calculateUsageCostUsd,
  OPENAI_RESPONSES_GPT_5_SKU,
  OPENROUTER_QWEN_SKU,
} from "./usage-pricing";

const db = createDb(env.DATABASE_URL!);

describe("credits", () => {
  let userId: string;

  beforeEach(async () => {
    const testUser = await createTestUser({ db });
    userId = testUser.user.id;
  });

  it("calculates balance using credits and usage", async () => {
    await grantUserCredits({
      db,
      grants: {
        userId,
        amountCents: 10_000,
        grantType: "signup_bonus",
      },
    });
    await grantUserCredits({
      db,
      grants: {
        userId,
        amountCents: 5_000,
        grantType: "admin_adjustment",
      },
    });

    const usageScenarios = [
      {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 500,
      },
      {
        inputTokens: 400,
        cachedInputTokens: 0,
        outputTokens: 600,
      },
    ];

    let expectedUsageUsd = 0;

    for (const usage of usageScenarios) {
      const costUsd = calculateUsageCostUsd({
        sku: OPENAI_RESPONSES_GPT_5_SKU,
        usage,
      });
      expectedUsageUsd += costUsd;
      await trackUsageEventBatched({
        db,
        userId,
        events: [
          {
            eventType: "billable_openai_usd",
            value: costUsd,
            tokenUsage: usage,
            sku: OPENAI_RESPONSES_GPT_5_SKU,
          },
        ],
      });
    }

    const cachedSummary = await getUserCreditBalance({ db, userId });
    const uncachedSummary = await getUserCreditBalance({
      db,
      userId,
      skipAggCache: true,
    });

    const expectedCredits = 15_000;
    const expectedUsageCents = Math.round(expectedUsageUsd * 100);
    const expectedBalance = expectedCredits - expectedUsageCents;

    expect(cachedSummary.totalCreditsCents).toBe(expectedCredits);
    expect(cachedSummary.totalUsageCents).toBe(expectedUsageCents);
    expect(cachedSummary.balanceCents).toBe(expectedBalance);
    expect(uncachedSummary).toEqual(cachedSummary);
  });

  it("returns zero balance for users without credits or usage", async () => {
    const otherUser = await createTestUser({ db });
    const summary = await getUserCreditBalance({
      db,
      userId: otherUser.user.id,
    });

    expect(summary).toEqual({
      totalCreditsCents: 0,
      totalUsageCents: 0,
      balanceCents: 0,
    });
  });

  it("increments the usage cache deterministically", async () => {
    const skuA = OPENAI_RESPONSES_GPT_5_SKU;
    const skuB = OPENROUTER_QWEN_SKU;
    const firstEventTs = new Date("2024-01-01T00:00:05.000Z");
    const secondEventTs = new Date("2024-01-01T00:00:10.000Z");
    const cacheCutoffInitial = new Date("2024-01-01T00:00:30.000Z");
    const lateEventTs = new Date("2024-01-01T00:01:00.000Z");
    const cacheCutoffLate = new Date("2024-01-01T00:02:00.000Z");

    const eventAInitial = {
      inputTokens: 100_000,
      cachedInputTokens: 10_000,
      cacheCreationInputTokens: 5_000,
      outputTokens: 50_000,
    } as const;
    const eventB = {
      inputTokens: 40_000,
      cachedInputTokens: 8_000,
      cacheCreationInputTokens: 0,
      outputTokens: 35_000,
    } as const;
    const eventALate = {
      inputTokens: 30_000,
      cachedInputTokens: 5_000,
      cacheCreationInputTokens: 0,
      outputTokens: 25_000,
    } as const;

    await trackUsageEventBatched({
      db,
      userId,
      events: [
        {
          eventType: "billable_openai_usd",
          value: calculateUsageCostUsd({ sku: skuA, usage: eventAInitial }),
          tokenUsage: eventAInitial,
          sku: skuA,
          createdAt: firstEventTs,
        },
      ],
    });

    await trackUsageEventBatched({
      db,
      userId,
      events: [
        {
          eventType: "billable_openrouter_usd",
          value: calculateUsageCostUsd({ sku: skuB, usage: eventB }),
          tokenUsage: eventB,
          sku: skuB,
          createdAt: secondEventTs,
        },
      ],
    });

    await updateUsageEventsAggCacheForUser({
      db,
      userId,
      upToDate: cacheCutoffInitial,
    });

    let cacheRows = await getCacheRows(userId);
    expect(cacheRows).toEqual([
      {
        sku: skuA,
        eventType: "billable_openai_usd",
        inputTokens: eventAInitial.inputTokens,
        cachedInputTokens: eventAInitial.cachedInputTokens,
        cacheCreationInputTokens: eventAInitial.cacheCreationInputTokens,
        outputTokens: eventAInitial.outputTokens,
        lastUsageTs: firstEventTs.toISOString(),
      },
      {
        sku: skuB,
        eventType: "billable_openrouter_usd",
        inputTokens: eventB.inputTokens,
        cachedInputTokens: eventB.cachedInputTokens,
        cacheCreationInputTokens: eventB.cacheCreationInputTokens,
        outputTokens: eventB.outputTokens,
        lastUsageTs: secondEventTs.toISOString(),
      },
    ]);

    // Nothing new should be applied if we call it again with the same cutoff
    await updateUsageEventsAggCacheForUser({
      db,
      userId,
      upToDate: cacheCutoffInitial,
    });
    expect(await getCacheRows(userId)).toEqual(cacheRows);

    await trackUsageEventBatched({
      db,
      userId,
      events: [
        {
          eventType: "billable_openai_usd",
          value: calculateUsageCostUsd({ sku: skuA, usage: eventALate }),
          tokenUsage: eventALate,
          sku: skuA,
          createdAt: lateEventTs,
        },
      ],
    });

    await updateUsageEventsAggCacheForUser({
      db,
      userId,
      upToDate: cacheCutoffLate,
    });

    cacheRows = await getCacheRows(userId);
    expect(cacheRows).toEqual([
      {
        sku: skuA,
        eventType: "billable_openai_usd",
        inputTokens: eventAInitial.inputTokens + eventALate.inputTokens,
        cachedInputTokens:
          eventAInitial.cachedInputTokens + eventALate.cachedInputTokens,
        cacheCreationInputTokens: eventAInitial.cacheCreationInputTokens,
        outputTokens: eventAInitial.outputTokens + eventALate.outputTokens,
        lastUsageTs: lateEventTs.toISOString(),
      },
      {
        sku: skuB,
        eventType: "billable_openrouter_usd",
        inputTokens: eventB.inputTokens,
        cachedInputTokens: eventB.cachedInputTokens,
        cacheCreationInputTokens: eventB.cacheCreationInputTokens,
        outputTokens: eventB.outputTokens,
        lastUsageTs: secondEventTs.toISOString(),
      },
    ]);

    const cached = await getUserCreditBalance({
      db,
      userId,
      skipAggCache: false,
    });
    const uncached = await getUserCreditBalance({
      db,
      userId,
      skipAggCache: true,
    });
    expect(cached).toEqual(uncached);
  });
});

describe("credit helpers", () => {
  describe("decimalValueToCents", () => {
    it("parses strings with rounding", () => {
      expect(decimalValueToCents("12.3456")).toBe(1235);
      expect(decimalValueToCents("12.344")).toBe(1234);
    });

    it("handles negatives and empty values", () => {
      expect(decimalValueToCents("-1.234")).toBe(-123);
      expect(decimalValueToCents("   ")).toBe(0);
      expect(decimalValueToCents(undefined)).toBe(0);
    });

    it("supports number inputs and strips non-digits", () => {
      expect(decimalValueToCents(1.23)).toBe(123);
      expect(decimalValueToCents("$1,234.56")).toBe(123456);
      expect(decimalValueToCents("abc12.34xyz")).toBe(1234);
    });

    it("rounds correctly when the third decimal digit is >= 5", () => {
      expect(decimalValueToCents("0.005")).toBe(1);
      expect(decimalValueToCents("-0.005")).toBe(-1);
    });

    it("handles very large whole numbers using bigint math", () => {
      const value = "12345678901234567890.12";
      expect(decimalValueToCents(value)).toBe(1234567890123456789012);
    });
  });

  describe("usdNumberToCents", () => {
    it("converts finite numbers with rounding", () => {
      expect(usdNumberToCents(1.234567)).toBe(123);
      expect(usdNumberToCents(-0.009)).toBe(-1);
    });

    it("returns zero for non-finite values", () => {
      expect(usdNumberToCents(Number.POSITIVE_INFINITY)).toBe(0);
      expect(usdNumberToCents(Number.NaN)).toBe(0);
    });
  });

  describe("sumAggregatedUsageCents", () => {
    it("uses SKU pricing when available", () => {
      const aggregates = [
        {
          sku: OPENAI_RESPONSES_GPT_5_SKU,
          inputTokens: 1_000_000,
          cachedInputTokens: 200_000,
          cacheCreationInputTokens: 0,
          outputTokens: 400_000,
        },
      ];

      const expectedUsd = calculateUsageCostUsd({
        sku: OPENAI_RESPONSES_GPT_5_SKU,
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 200_000,
          cacheCreationInputTokens: 0,
          outputTokens: 400_000,
        },
      });

      expect(sumAggregatedUsageCents(aggregates)).toBe(
        usdNumberToCents(expectedUsd),
      );
    });

    it("ignores aggregates without a SKU", () => {
      const aggregates = [
        {
          sku: null,
          inputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 0,
        },
      ];

      expect(sumAggregatedUsageCents(aggregates)).toBe(0);
    });
  });
});

async function getCacheRows(userId: string) {
  const rows = await db
    .select({
      sku: schema.usageEventsAggCacheSku.sku,
      eventType: schema.usageEventsAggCacheSku.eventType,
      inputTokens: schema.usageEventsAggCacheSku.inputTokens,
      cachedInputTokens: schema.usageEventsAggCacheSku.cachedInputTokens,
      cacheCreationInputTokens:
        schema.usageEventsAggCacheSku.cacheCreationInputTokens,
      outputTokens: schema.usageEventsAggCacheSku.outputTokens,
      lastUsageTs: schema.usageEventsAggCacheSku.lastUsageTs,
    })
    .from(schema.usageEventsAggCacheSku)
    .where(eq(schema.usageEventsAggCacheSku.userId, userId))
    .orderBy(
      schema.usageEventsAggCacheSku.sku,
      schema.usageEventsAggCacheSku.eventType,
    );

  return rows.map((row) => ({
    sku: row.sku,
    eventType: row.eventType,
    inputTokens: Number(row.inputTokens ?? 0n),
    cachedInputTokens: Number(row.cachedInputTokens ?? 0n),
    cacheCreationInputTokens: Number(row.cacheCreationInputTokens ?? 0n),
    outputTokens: Number(row.outputTokens ?? 0n),
    lastUsageTs: row.lastUsageTs?.toISOString() ?? null,
  }));
}
