/**
 * Dynamic import wrapper for @terragon/shared/db.
 * Uses dynamic import to avoid ERR_PACKAGE_PATH_NOT_EXPORTED with tsx CJS resolution.
 */

// Type-only import works fine (stripped at compile time)
import type { DB } from "@terragon/shared/db";

export type { DB };

export async function createDb(connectionString: string): Promise<DB> {
  const { createDb: _createDb } = await import("@terragon/shared/db");
  return _createDb(connectionString);
}
