/**
 * Generic, defensive readers for untyped JSON-RPC / notification payloads.
 * Shared by the daemon's RPC parsing and the canonical-event builder so the
 * same record/string/boolean access logic isn't duplicated across modules.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null;
}

export function readString(
  value: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!value) {
    return null;
  }
  const keyValue = value[key];
  return typeof keyValue === "string" ? keyValue : null;
}

export function readBoolean(
  value: Record<string, unknown> | null,
  key: string,
): boolean | null {
  if (!value) {
    return null;
  }
  const keyValue = value[key];
  return typeof keyValue === "boolean" ? keyValue : null;
}
