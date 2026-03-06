"use server";

import { adminOnly } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { env } from "@terragon/env/apps-www";
import { User } from "@terragon/shared";
import { decryptValue } from "@terragon/utils/encryption";
import {
  getMacMiniWorkers,
  getMacMiniWorkerById,
  createMacMiniWorker,
  updateMacMiniWorker,
  deleteMacMiniWorker,
  setMacMiniWorkerStatus,
  getMacMiniAllocations,
} from "@terragon/shared/model/mac-mini-workers";

export const addMacMiniWorker = adminOnly(async function addMacMiniWorker(
  _adminUser: User,
  data: {
    name: string;
    hostname: string;
    port: number;
    apiKey: string;
    cpuCores?: number;
    memoryGB?: number;
    osVersion?: string;
  },
) {
  const worker = await createMacMiniWorker(db, {
    ...data,
    encryptionKey: env.ENCRYPTION_MASTER_KEY,
  });

  // Ping the health endpoint to verify connectivity
  let healthy = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(
        `http://${data.hostname}:${data.port}/health`,
        {
          headers: { Authorization: `Bearer ${data.apiKey}` },
          signal: controller.signal,
        },
      );
      healthy = response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    healthy = false;
  }

  if (healthy) {
    await setMacMiniWorkerStatus(db, worker.id, "online");
    return { ...worker, status: "online" as const, apiKeyEncrypted: undefined };
  }

  const { apiKeyEncrypted: _, ...workerWithoutKey } = worker;
  return workerWithoutKey;
});

export const removeMacMiniWorker = adminOnly(async function removeMacMiniWorker(
  _adminUser: User,
  id: string,
) {
  const allocations = await getMacMiniAllocations(db, id);
  if (allocations.length > 0) {
    throw new Error(
      `Cannot remove worker: ${allocations.length} active allocation(s) exist`,
    );
  }
  await deleteMacMiniWorker(db, id);
});

export const updateMacMiniWorkerSettings = adminOnly(
  async function updateMacMiniWorkerSettings(
    _adminUser: User,
    id: string,
    data: {
      name?: string;
      hostname?: string;
      port?: number;
      maxConcurrentSandboxes?: number;
    },
  ) {
    return updateMacMiniWorker(db, id, data);
  },
);

export const drainMacMiniWorker = adminOnly(async function drainMacMiniWorker(
  _adminUser: User,
  id: string,
) {
  return setMacMiniWorkerStatus(db, id, "draining");
});

export const setMacMiniMaintenance = adminOnly(
  async function setMacMiniMaintenance(_adminUser: User, id: string) {
    return setMacMiniWorkerStatus(db, id, "maintenance");
  },
);

export const bringMacMiniOnline = adminOnly(async function bringMacMiniOnline(
  _adminUser: User,
  id: string,
) {
  const worker = await getMacMiniWorkerById(db, id);
  if (!worker) {
    throw new Error("Worker not found");
  }

  const apiKey = decryptValue(
    worker.apiKeyEncrypted,
    env.ENCRYPTION_MASTER_KEY,
  );

  let healthy = false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(
        `http://${worker.hostname}:${worker.port}/health`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        },
      );
      healthy = response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    healthy = false;
  }

  if (healthy) {
    await setMacMiniWorkerStatus(db, id, "online");
  }

  return { success: healthy };
});

export const getMacMiniFleet = adminOnly(async function getMacMiniFleet(
  _adminUser: User,
) {
  const workers = await getMacMiniWorkers(db);
  const allocations = await getMacMiniAllocations(db);

  return workers.map(({ apiKeyEncrypted: _, ...worker }) => ({
    ...worker,
    allocations: allocations.filter((a) => a.workerId === worker.id),
  }));
});

export const getMacMiniWorkerDetail = adminOnly(
  async function getMacMiniWorkerDetail(_adminUser: User, id: string) {
    const worker = await getMacMiniWorkerById(db, id);
    if (!worker) return null;
    const { apiKeyEncrypted: _, ...workerWithoutKey } = worker;
    const allocations = await getMacMiniAllocations(db, id);
    return { ...workerWithoutKey, allocations };
  },
);
