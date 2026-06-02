import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import {
  getArrayField,
  getObjectField,
  getStringField,
} from "./renderable-part-shape";
import type { ThreadViewQuarantineEntry } from "./types";

export function isUnsupportedNativeRuntimeEvent(event: BaseEvent): boolean {
  switch (event.type) {
    case EventType.RAW:
      return true;
    default:
      return false;
  }
}

/**
 * Validates native AG-UI STATE and ACTIVITY runtime events and quarantines
 * malformed ones. The projected runtime state was never read by live code, so
 * only the quarantine side-effect survives; returns `null` for well-formed or
 * non-runtime events. Patch operations are checked structurally (parseable op,
 * non-prototype-polluting path) rather than against accumulated state, which no
 * longer exists.
 */
export function quarantineNativeRuntimeEvent(
  event: BaseEvent,
): ThreadViewQuarantineEntry | null {
  switch (event.type) {
    case EventType.STATE_SNAPSHOT: {
      return getObjectField(event, "snapshot")
        ? null
        : malformedNativeRuntimeEvent(event);
    }
    case EventType.STATE_DELTA: {
      const delta = getArrayField(event, "delta");
      if (!delta || !isWellFormedPatch(delta)) {
        return malformedNativeRuntimeEvent(event);
      }
      return null;
    }
    case EventType.ACTIVITY_SNAPSHOT: {
      const messageId = getStringField(event, "messageId");
      const activityType = getStringField(event, "activityType");
      const content = getObjectField(event, "content");
      return messageId && activityType && content
        ? null
        : malformedNativeRuntimeEvent(event);
    }
    case EventType.ACTIVITY_DELTA: {
      const messageId = getStringField(event, "messageId");
      const activityType = getStringField(event, "activityType");
      const patch = getArrayField(event, "patch");
      if (!messageId || !activityType || !patch || !isWellFormedPatch(patch)) {
        return malformedNativeRuntimeEvent(event);
      }
      return null;
    }
    default:
      return null;
  }
}

function isWellFormedPatch(operations: unknown[]): boolean {
  return operations.every(isWellFormedPatchOperation);
}

function isWellFormedPatchOperation(value: unknown): boolean {
  const op = getStringField(value, "op");
  const path = getStringField(value, "path");
  if (!op || path === null) {
    return false;
  }
  if (op !== "add" && op !== "replace" && op !== "remove") {
    return false;
  }
  return path === "" || isSafeJsonPointer(path);
}

function isSafeJsonPointer(path: string): boolean {
  if (!path.startsWith("/")) {
    return false;
  }
  return path
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    .every(
      (token) =>
        token !== "__proto__" &&
        token !== "constructor" &&
        token !== "prototype",
    );
}

function malformedNativeRuntimeEvent(
  event: BaseEvent,
): ThreadViewQuarantineEntry {
  return {
    reason: "malformed-native-runtime-event",
    eventType: String(event.type),
  };
}
