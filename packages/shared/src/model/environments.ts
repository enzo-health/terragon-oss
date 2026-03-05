import { DB } from "../db";
import * as schema from "../db/schema";
import type { EnvironmentSnapshot } from "../db/schema";
import { and, eq, getTableColumns } from "drizzle-orm";
import { publishBroadcastUserMessage } from "../broadcast-server";
import { decryptValue } from "@terragon/utils/encryption";
import type { SandboxSize } from "@terragon/types/sandbox";

export function getEnvironments({
  db,
  userId,
  includeGlobal,
}: {
  db: DB;
  userId: string;
  includeGlobal: boolean;
}) {
  return db.query.environment.findMany({
    where: and(
      eq(schema.environment.userId, userId),
      ...(includeGlobal ? [] : [eq(schema.environment.isGlobal, false)]),
    ),
  });
}

export function getEnvironment({
  db,
  environmentId,
  userId,
}: {
  db: DB;
  environmentId: string;
  userId: string;
}) {
  return db.query.environment.findFirst({
    where: and(
      eq(schema.environment.userId, userId),
      eq(schema.environment.id, environmentId),
    ),
  });
}

export async function getOrCreateGlobalEnvironment({
  db,
  userId,
}: {
  db: DB;
  userId: string;
}) {
  return await getOrCreateEnvironment({
    db,
    userId,
    repoFullName: "",
    isGlobal: true,
  });
}

export async function getOrCreateEnvironment({
  db,
  userId,
  repoFullName,
  isGlobal = false,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
  isGlobal?: boolean;
}) {
  const getEnvironmentInner = async () => {
    const where = [eq(schema.environment.userId, userId)];
    if (isGlobal) {
      where.push(eq(schema.environment.isGlobal, true));
    }
    if (repoFullName) {
      where.push(eq(schema.environment.repoFullName, repoFullName));
    }
    return await db.query.environment.findFirst({ where: and(...where) });
  };

  const existingEnvironment = await getEnvironmentInner();
  if (existingEnvironment) {
    return existingEnvironment;
  }

  // Try to insert first with ON CONFLICT DO NOTHING to handle race conditions
  const result = await db
    .insert(schema.environment)
    .values({
      userId,
      repoFullName,
      isGlobal,
    })
    .onConflictDoNothing()
    .returning();
  // If insert succeeded, we created a new environment
  if (result.length > 0) {
    const environment = result[0]!;
    await publishBroadcastUserMessage({
      type: "user",
      id: userId,
      data: {
        environmentId: environment.id,
      },
    });
    return environment;
  }
  const environment = await getEnvironmentInner();
  if (!environment) {
    throw new Error("Failed to get or create environment");
  }
  return environment;
}

export async function updateEnvironment({
  db,
  userId,
  environmentId,
  updates,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  updates: Partial<
    Omit<
      typeof schema.environment.$inferSelect,
      "id" | "userId" | "repoFullName"
    >
  >;
}) {
  // @ts-expect-error - repoFullName and userId are not updatable
  if (updates.repoFullName || updates.userId) {
    throw new Error("Cannot update repoFullName or userId");
  }
  await db
    .update(schema.environment)
    .set(updates)
    .where(
      and(
        eq(schema.environment.userId, userId),
        eq(schema.environment.id, environmentId),
      ),
    );
  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      environmentId,
    },
  });
}

export async function deleteEnvironmentById({
  db,
  userId,
  environmentId,
}: {
  db: DB;
  userId: string;
  environmentId: string;
}) {
  const environment = await getEnvironment({
    db,
    userId,
    environmentId,
  });

  if (!environment) {
    return;
  }

  await db
    .delete(schema.environment)
    .where(
      and(
        eq(schema.environment.userId, userId),
        eq(schema.environment.id, environmentId),
      ),
    );

  await publishBroadcastUserMessage({
    type: "user",
    id: userId,
    data: {
      environmentId,
    },
  });
}

export async function getDecryptedGlobalEnvironmentVariables({
  db,
  userId,
  encryptionMasterKey,
}: {
  db: DB;
  userId: string;
  encryptionMasterKey: string;
}): Promise<Array<{ key: string; value: string }>> {
  const globalEnvironment = await getOrCreateGlobalEnvironment({ db, userId });
  if (!globalEnvironment) {
    return [];
  }
  return getDecryptedEnvironmentVariables({
    db,
    userId,
    environmentId: globalEnvironment.id,
    encryptionMasterKey,
  });
}

export async function getDecryptedEnvironmentVariables({
  db,
  userId,
  environmentId,
  encryptionMasterKey,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  encryptionMasterKey: string;
}): Promise<Array<{ key: string; value: string }>> {
  const environment = await getEnvironment({ db, userId, environmentId });
  if (!environment) {
    throw new Error("Environment not found");
  }
  return (
    (environment.environmentVariables
      ?.map((variable) => {
        // Backwards compatibility with old environment variables
        if ("value" in variable) {
          return {
            key: variable.key,
            value: variable.value,
          };
        }
        try {
          return {
            key: variable.key,
            value: decryptValue(variable.valueEncrypted, encryptionMasterKey),
          };
        } catch (error) {
          console.error("Failed to decrypt environment variable:", error);
          return null;
        }
      })
      .filter(Boolean) as Array<{ key: string; value: string }>) ?? []
  );
}

export async function getDecryptedMcpConfig({
  db,
  userId,
  environmentId,
  encryptionMasterKey,
}: {
  db: DB;
  userId: string;
  environmentId: string;
  encryptionMasterKey: string;
}): Promise<{ mcpServers: Record<string, any> } | null> {
  const environment = await getEnvironment({ db, userId, environmentId });
  if (!environment || !environment.mcpConfigEncrypted) {
    return null;
  }

  try {
    const decryptedConfig = decryptValue(
      environment.mcpConfigEncrypted,
      encryptionMasterKey,
    );
    return JSON.parse(decryptedConfig);
  } catch (error) {
    console.error("Failed to decrypt MCP config:", error);
    return null;
  }
}

export async function getEnvironmentForAdmin({
  db,
  environmentId,
}: {
  db: DB;
  environmentId: string;
}) {
  const result = await db
    .select({
      ...getTableColumns(schema.environment),
      user: {
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
      },
    })
    .from(schema.environment)
    .innerJoin(schema.user, eq(schema.environment.userId, schema.user.id))
    .where(eq(schema.environment.id, environmentId))
    .limit(1);
  if (result.length === 0) {
    return undefined;
  }
  return result[0];
}

export async function getEnvironmentForUserRepo({
  db,
  userId,
  repoFullName,
}: {
  db: DB;
  userId: string;
  repoFullName: string;
}) {
  return await db.query.environment.findFirst({
    where: and(
      eq(schema.environment.userId, userId),
      eq(schema.environment.repoFullName, repoFullName),
    ),
  });
}

export function getReadySnapshot(
  environment: { snapshots: EnvironmentSnapshot[] | null },
  provider: "daytona",
  size: SandboxSize,
  filters?: {
    setupScriptHash?: string;
    baseDockerfileHash?: string;
    environmentVariablesHash?: string;
    mcpConfigHash?: string;
  },
): EnvironmentSnapshot | null {
  const {
    setupScriptHash,
    baseDockerfileHash,
    environmentVariablesHash,
    mcpConfigHash,
  } = filters ?? {};
  return (
    environment.snapshots?.find(
      (s) =>
        s.provider === provider &&
        s.size === size &&
        s.status === "ready" &&
        (setupScriptHash ? s.setupScriptHash === setupScriptHash : true) &&
        (baseDockerfileHash ? s.baseDockerfileHash === baseDockerfileHash : true) &&
        (environmentVariablesHash
          ? s.environmentVariablesHash === environmentVariablesHash
          : true) &&
        (mcpConfigHash ? s.mcpConfigHash === mcpConfigHash : true),
    ) ?? null
  );
}

export async function updateEnvironmentSnapshot({
  db,
  environmentId,
  userId,
  snapshot,
}: {
  db: DB;
  environmentId: string;
  userId: string;
  snapshot: EnvironmentSnapshot;
}): Promise<void> {
  const environment = await getEnvironment({ db, environmentId, userId });
  if (!environment) {
    throw new Error("Environment not found");
  }
  const existing = environment.snapshots ?? [];
  const idx = existing.findIndex(
    (s) => s.provider === snapshot.provider && s.size === snapshot.size,
  );
  const updated = [...existing];
  if (idx >= 0) {
    updated[idx] = snapshot;
  } else {
    updated.push(snapshot);
  }
  await updateEnvironment({
    db,
    userId,
    environmentId,
    updates: { snapshots: updated },
  });
}

export async function markSnapshotsStale({
  db,
  environmentId,
  userId,
}: {
  db: DB;
  environmentId: string;
  userId: string;
}): Promise<void> {
  const environment = await getEnvironment({ db, environmentId, userId });
  if (!environment) return;
  const snapshots = environment.snapshots ?? [];
  if (snapshots.length === 0) return;
  const updated = snapshots.map((s) =>
    s.status === "ready" ? { ...s, status: "stale" as const } : s,
  );
  await updateEnvironment({
    db,
    userId,
    environmentId,
    updates: { snapshots: updated },
  });
}
