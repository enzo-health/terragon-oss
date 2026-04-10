/**
 * Dynamic import wrapper for @leo/shared/db.
 * Uses dynamic import to avoid ERR_PACKAGE_PATH_NOT_EXPORTED with tsx CJS resolution.
 */

// Type-only import works fine (stripped at compile time)
import type { DB } from "@leo/shared/db";

export type { DB };

export async function createDb(connectionString: string): Promise<DB> {
  const { createDb: _createDb } = await import("@leo/shared/db");
  return _createDb(connectionString);
}
