import type { NextRequest } from "next/server";
import {
  getStalledThreads,
  stopStalledThreads,
  getStalledThreadChats,
  stopStalledThreadChats,
} from "@terragon/shared/model/threads";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { maybeHibernateSandboxById } from "@/agent/sandbox";
import { setActiveThreadChat } from "@/agent/sandbox-resource";
import {
  getStaleBootingThreadChats,
  requeueStaleBootingThreadChats,
} from "@/server-lib/booting-recovery";

async function sleep(ms: number = 1000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopStalledThreadsTask() {
  console.log("Processing stalled threads");
  const stalledThreads = await getStalledThreads({ db });
  console.log(`Found ${stalledThreads.length} stalled threads`);
  if (stalledThreads.length === 0) {
    return;
  }

  console.log("Stopping stalled threads");
  console.log(stalledThreads.map((thread) => thread.id).join(", "));
  await stopStalledThreads({
    db,
    threadIds: stalledThreads.map((thread) => thread.id),
  });

  // Hibernate the sandboxes in batches of 10
  console.log("Hibernating sandboxes");
  for (let i = 0; i < stalledThreads.length; i += 10) {
    const batch = stalledThreads.slice(i, i + 10);
    await Promise.all(
      batch.map(async (thread) => {
        if (thread.codesandboxId) {
          try {
            await maybeHibernateSandboxById({
              threadId: thread.id,
              userId: thread.userId,
              sandboxId: thread.codesandboxId,
              sandboxProvider: thread.sandboxProvider,
            });
          } catch (error) {
            // Ignore errors
          }
        }
      }),
    );
    await sleep();
  }
}

async function stopStalledThreadChatsTask() {
  console.log("Processing stalled thread chats");
  const stalledThreadChats = await getStalledThreadChats({ db });
  console.log(`Found ${stalledThreadChats.length} stalled thread chats`);
  if (stalledThreadChats.length === 0) {
    return;
  }

  console.log("Stopping stalled thread chats");
  console.log(
    stalledThreadChats.map((tc) => ({
      id: tc.id,
      threadId: tc.threadId,
      status: tc.status,
    })),
  );
  await stopStalledThreadChats({
    db,
    threadChatIds: stalledThreadChats.map((tc) => tc.id),
  });

  // Clean up Redis active-thread-chats set for each stalled thread chat
  console.log("Cleaning up Redis for stalled thread chats");
  for (const tc of stalledThreadChats) {
    if (tc.codesandboxId) {
      try {
        await setActiveThreadChat({
          sandboxId: tc.codesandboxId,
          threadChatId: tc.id,
          isActive: false,
        });
      } catch (error) {
        console.error(
          `Failed to clean up Redis for thread chat ${tc.id}`,
          error,
        );
      }
    }
  }

  // Hibernate sandboxes in batches of 10
  const sandboxes = new Map(
    stalledThreadChats
      .filter((tc) => tc.codesandboxId)
      .map((tc) => [
        tc.codesandboxId!,
        {
          threadId: tc.threadId,
          userId: tc.userId,
          sandboxProvider: tc.sandboxProvider,
        },
      ]),
  );
  console.log(`Hibernating ${sandboxes.size} sandboxes`);
  const sandboxEntries = Array.from(sandboxes.entries());
  for (let i = 0; i < sandboxEntries.length; i += 10) {
    const batch = sandboxEntries.slice(i, i + 10);
    await Promise.all(
      batch.map(async ([sandboxId, { threadId, userId, sandboxProvider }]) => {
        try {
          await maybeHibernateSandboxById({
            threadId,
            userId,
            sandboxId,
            sandboxProvider,
          });
        } catch (error) {
          // Ignore errors
        }
      }),
    );
    await sleep();
  }
}

const STALE_BOOTING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

async function requeueStaleBootingThreadChatsTask() {
  console.log("Processing stale booting thread chats");
  const staleBootingThreadChats = await getStaleBootingThreadChats({
    db,
    maxAgeMs: STALE_BOOTING_MAX_AGE_MS,
  });
  console.log(
    `Found ${staleBootingThreadChats.length} stale booting thread chats`,
  );
  if (staleBootingThreadChats.length === 0) {
    return;
  }
  const { requeuedCount } = await requeueStaleBootingThreadChats({
    db,
    threadChats: staleBootingThreadChats,
  });
  console.log(`Requeued ${requeuedCount} stale booting thread chats`);
}

// This is run every 5 minutes, see vercel.json.
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (
    process.env.NODE_ENV === "production" &&
    authHeader !== `Bearer ${env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", {
      status: 401,
    });
  }
  console.log("Stalled tasks cron task triggered");
  await requeueStaleBootingThreadChatsTask();
  await stopStalledThreadsTask();
  await stopStalledThreadChatsTask();
  console.log("Stalled tasks cron task completed");
  return Response.json({ success: true });
}
