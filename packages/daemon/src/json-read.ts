/**
 * Generic, defensive readers for untyped JSON-RPC / notification payloads.
 * Shared by the daemon's RPC parsing and the canonical-event builder so the
 * same record/string/boolean access logic isn't duplicated across modules.
 */

export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
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
