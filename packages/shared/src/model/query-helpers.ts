/**
 * Generic get-or-create helper that handles the common race-condition-safe
 * "find first, insert if missing" pattern used across the codebase.
 *
 * Example (user settings):
 *   const settings = await getOrCreate({
 *     findExisting: () => db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId) }),
 *     insert: () => db.insert(schema.userSettings).values({ userId }).onConflictDoNothing().returning(),
 *     findInserted: () => db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, userId) }),
 *   });
 */
export async function getOrCreate<T>({
  findExisting,
  insert,
  findInserted,
}: {
  findExisting: () => Promise<T | undefined | null>;
  insert: () => Promise<T[]>;
  findInserted: () => Promise<T | undefined | null>;
}): Promise<T> {
  const existing = await findExisting();
  if (existing != null) {
    return existing;
  }

  const inserted = await insert();
  if (inserted[0] != null) {
    return inserted[0];
  }

  const fallback = await findInserted();
  if (fallback != null) {
    return fallback;
  }

  throw new Error("getOrCreate: row not found after insert");
}

/**
 * Upsert a row and then best-effort broadcast the change.
 * The broadcast is fire-and-forget: it logs on failure but never
 * throws, so the DB write is always the authoritative action.
 *
 * Example (thread read status):
 *   await upsertAndBroadcast({
 *     upsert: () => db.insert(schema.threadReadStatus).values({ ... }).onConflictDoUpdate({ ... }),
 *     broadcast: () => publishBroadcastUserMessage({ threadId, userId, data: { isRead } }),
 *   });
 */
export async function upsertAndBroadcast({
  upsert,
  broadcast,
}: {
  upsert: () => Promise<unknown>;
  broadcast: () => Promise<unknown>;
}): Promise<void> {
  await upsert();
  try {
    await broadcast();
  } catch (error) {
    console.warn("[query-helpers] Broadcast failed after upsert", { error });
  }
}
