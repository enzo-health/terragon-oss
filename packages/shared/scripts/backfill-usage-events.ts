import { createDb } from "../src/db";
import * as schema from "../src/db/schema";
import { DBMessage } from "../src/db/db-message";
import { env } from "@leo/env/pkg-shared";
import { count } from "drizzle-orm";
import type { UsageEventInsert } from "../src/db/types";

// Helper function to sleep between batches
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Configuration
const BATCH_SIZE = 50;
const SLEEP_MS = 500;

export async function backfillUsageEvents(db = createDb(env.DATABASE_URL!)) {
  console.log("Starting usage events backfill...");
  const usageEvents = await db
    .select({ count: count() })
    .from(schema.usageEvents);
  if (usageEvents[0]!.count > 0) {
    console.log("Usage events already backfilled");
    return;
  }

  // Get total thread count
  const threadCount = await db.select({ count: count() }).from(schema.thread);
  const totalThreads = threadCount[0]!.count;
  console.log(`Found ${totalThreads} threads to process`);

  let totalEventsCreated = 0;
  let threadsProcessed = 0;
  let offset = 0;
  let batch = 0;
  const numBatches = Math.ceil(totalThreads / BATCH_SIZE);

  // Process threads in batches
  while (offset < totalThreads) {
    // Fetch batch of threads
    const threads = await db
      .select()
      .from(schema.thread)
      .limit(BATCH_SIZE)
      .offset(offset);

    console.log(
      `Processing batch: ${offset + 1}-${Math.min(offset + BATCH_SIZE, totalThreads)} of ${totalThreads}`,
    );

    // Process each thread in the batch
    for (const t of threads) {
      if (!t.messages || !Array.isArray(t.messages)) {
        continue;
      }
      const eventsToInsert: UsageEventInsert[] = [];

      let timestamp = t.createdAt;
      for (const message of t.messages as DBMessage[]) {
        if ("timestamp" in message && message.timestamp) {
          timestamp = new Date(message.timestamp);
        }
        if (message.type === "meta") {
          if (
            message.subtype !== "result-success" &&
            message.subtype !== "result-error-max-turns"
          ) {
            continue;
          }
          // Add Claude cost event
          if (message.cost_usd > 0) {
            eventsToInsert.push({
              userId: t.userId,
              eventType: "claude_cost_usd" as const,
              value: message.cost_usd.toString(),
              createdAt: timestamp,
            });
          }
          // Add sandbox usage time event
          if (message.duration_ms > 0) {
            eventsToInsert.push({
              userId: t.userId,
              eventType: "sandbox_usage_time_agent_ms" as const,
              value: message.duration_ms.toString(),
              createdAt: timestamp,
            });
          }
        }
      }

      // Insert events for this thread
      if (eventsToInsert.length > 0) {
        await db.insert(schema.usageEvents).values(eventsToInsert);
        totalEventsCreated += eventsToInsert.length;
        console.log(
          `Created ${eventsToInsert.length} events for thread ${t.id}`,
        );
      }
      threadsProcessed++;
    }

    // Update offset for next batch
    offset += BATCH_SIZE;
    batch++;

    // Sleep between batches if not the last batch
    if (offset < totalThreads) {
      console.log(
        `Sleeping for ${SLEEP_MS}ms before next batch... (${batch}/${numBatches})`,
      );
      await sleep(SLEEP_MS);
    }
  }
  console.log(`\nBackfill complete!`);
  console.log(`Total threads processed: ${threadsProcessed}`);
  console.log(`Total events created: ${totalEventsCreated}`);
}

// Run the backfill if this file is executed directly
async function main() {
  const db = createDb(env.DATABASE_URL!);
  await backfillUsageEvents(db);
}

main()
  .then(() => {
    console.log("Backfill completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exit(1);
  });
