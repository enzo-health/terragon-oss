import { eq, asc, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import type { DB } from "../db";
import { encryptValue } from "@terragon/utils/encryption";

export async function getMacMiniWorkers(db: DB) {
  return db
    .select()
    .from(schema.macMiniWorker)
    .orderBy(asc(schema.macMiniWorker.name));
}

export async function getMacMiniWorkerById(db: DB, id: string) {
  const result = await db.query.macMiniWorker.findFirst({
    where: eq(schema.macMiniWorker.id, id),
  });
  return result ?? null;
}

export async function createMacMiniWorker(
  db: DB,
  data: {
    name: string;
    hostname: string;
    port: number;
    apiKey: string;
    encryptionKey: string;
    cpuCores?: number;
    memoryGB?: number;
    osVersion?: string;
  },
) {
  const {
    name,
    hostname,
    port,
    apiKey,
    encryptionKey,
    cpuCores,
    memoryGB,
    osVersion,
  } = data;
  const apiKeyEncrypted = encryptValue(apiKey, encryptionKey);
  const [row] = await db
    .insert(schema.macMiniWorker)
    .values({
      name,
      hostname,
      port,
      apiKeyEncrypted,
      cpuCores,
      memoryGB,
      osVersion,
    })
    .returning();
  return row!;
}

export async function updateMacMiniWorker(
  db: DB,
  id: string,
  data: Partial<{
    name: string;
    hostname: string;
    port: number;
    status: "online" | "offline" | "draining" | "maintenance";
    maxConcurrentSandboxes: number;
  }>,
) {
  const [row] = await db
    .update(schema.macMiniWorker)
    .set(data)
    .where(eq(schema.macMiniWorker.id, id))
    .returning();
  return row!;
}

export async function deleteMacMiniWorker(db: DB, id: string) {
  await db.delete(schema.macMiniWorker).where(eq(schema.macMiniWorker.id, id));
}

export async function setMacMiniWorkerStatus(
  db: DB,
  id: string,
  status: "online" | "offline" | "draining" | "maintenance",
) {
  const [row] = await db
    .update(schema.macMiniWorker)
    .set({ status })
    .where(eq(schema.macMiniWorker.id, id))
    .returning();
  return row!;
}

export async function recordHealthCheck(
  db: DB,
  id: string,
  success: boolean,
  info?: {
    osVersion?: string;
    openSandboxVersion?: string;
    dockerVersion?: string;
  },
) {
  if (success) {
    await db
      .update(schema.macMiniWorker)
      .set({
        lastHealthCheckAt: new Date(),
        lastHealthCheckSuccess: true,
        consecutiveHealthFailures: 0,
        ...(info?.osVersion !== undefined ? { osVersion: info.osVersion } : {}),
        ...(info?.openSandboxVersion !== undefined
          ? { openSandboxVersion: info.openSandboxVersion }
          : {}),
        ...(info?.dockerVersion !== undefined
          ? { dockerVersion: info.dockerVersion }
          : {}),
      })
      .where(eq(schema.macMiniWorker.id, id));
  } else {
    // Increment failures and set offline if >= 3
    await db
      .update(schema.macMiniWorker)
      .set({
        lastHealthCheckAt: new Date(),
        lastHealthCheckSuccess: false,
        consecutiveHealthFailures: sql`${schema.macMiniWorker.consecutiveHealthFailures} + 1`,
      })
      .where(eq(schema.macMiniWorker.id, id));

    // Check if we crossed the threshold and need to set offline
    const worker = await getMacMiniWorkerById(db, id);
    if (worker && worker.consecutiveHealthFailures >= 3) {
      await db
        .update(schema.macMiniWorker)
        .set({ status: "offline" })
        .where(eq(schema.macMiniWorker.id, id));
    }
  }
}

export async function getMacMiniAllocations(db: DB, workerId?: string) {
  if (workerId !== undefined) {
    return db
      .select()
      .from(schema.macMiniSandboxAllocation)
      .where(eq(schema.macMiniSandboxAllocation.workerId, workerId));
  }
  return db.select().from(schema.macMiniSandboxAllocation);
}

export async function createAllocation(
  db: DB,
  data: { workerId: string; sandboxId: string; threadId?: string },
) {
  const [row] = await db
    .insert(schema.macMiniSandboxAllocation)
    .values(data)
    .returning();
  return row!;
}

export async function deleteAllocation(db: DB, sandboxId: string) {
  await db
    .delete(schema.macMiniSandboxAllocation)
    .where(eq(schema.macMiniSandboxAllocation.sandboxId, sandboxId));
}

/**
 * Atomically reserve an available worker by incrementing its sandbox count.
 * Returns the updated worker row, or null if no worker is available.
 */
export async function allocateMacMiniWorker(db: DB) {
  const rows = await db
    .update(schema.macMiniWorker)
    .set({
      currentSandboxCount: sql`${schema.macMiniWorker.currentSandboxCount} + 1`,
    })
    .where(
      sql`${schema.macMiniWorker.id} = (
        SELECT id FROM mac_mini_worker
        WHERE status = 'online'
          AND current_sandbox_count < max_concurrent_sandboxes
        ORDER BY current_sandbox_count ASC, last_health_check_at DESC NULLS LAST
        LIMIT 1
      )`,
    )
    .returning();
  return rows[0] ?? null;
}

export async function updateAllocationStatus(
  db: DB,
  sandboxId: string,
  status: "running" | "paused" | "stopped",
) {
  await db
    .update(schema.macMiniSandboxAllocation)
    .set({ status })
    .where(eq(schema.macMiniSandboxAllocation.sandboxId, sandboxId));
}

export async function releaseWorker(db: DB, sandboxId: string) {
  await db.transaction(async (tx) => {
    const allocation = await tx.query.macMiniSandboxAllocation.findFirst({
      where: eq(schema.macMiniSandboxAllocation.sandboxId, sandboxId),
    });
    if (!allocation) return;

    await tx
      .delete(schema.macMiniSandboxAllocation)
      .where(eq(schema.macMiniSandboxAllocation.sandboxId, sandboxId));

    await tx
      .update(schema.macMiniWorker)
      .set({
        currentSandboxCount: sql`GREATEST(${schema.macMiniWorker.currentSandboxCount} - 1, 0)`,
      })
      .where(eq(schema.macMiniWorker.id, allocation.workerId));
  });
}
