import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import { applyJsonPatchOperations } from "./json-patch";
import {
  getArrayField,
  getBooleanField,
  getObjectField,
  getStringField,
} from "./renderable-part-shape";
import type {
  ThreadViewModelState,
  ThreadViewQuarantineEntry,
  ThreadViewRuntimeActivities,
  ThreadViewRuntimeState,
} from "./types";

export function isUnsupportedNativeRuntimeEvent(event: BaseEvent): boolean {
  switch (event.type) {
    case EventType.RAW:
      return true;
    default:
      return false;
  }
}

export function applyNativeRuntimeEvent(
  state: ThreadViewModelState,
  event: BaseEvent,
):
  | {
      runtimeState: ThreadViewRuntimeState;
      runtimeActivities: ThreadViewRuntimeActivities;
      quarantineEntry?: undefined;
    }
  | {
      quarantineEntry: ThreadViewQuarantineEntry;
    }
  | null {
  switch (event.type) {
    case EventType.STATE_SNAPSHOT: {
      const snapshot = getObjectField(event, "snapshot");
      if (!snapshot) {
        return malformedNativeRuntimeEvent(event);
      }
      return {
        runtimeState: { ...snapshot },
        runtimeActivities: state.runtimeActivities,
      };
    }
    case EventType.STATE_DELTA: {
      const delta = getArrayField(event, "delta");
      if (!delta) {
        return malformedNativeRuntimeEvent(event);
      }
      const runtimeState = applyJsonPatchOperations(state.runtimeState, delta);
      if (!runtimeState) {
        return malformedNativeRuntimeEvent(event);
      }
      return {
        runtimeState,
        runtimeActivities: state.runtimeActivities,
      };
    }
    case EventType.ACTIVITY_SNAPSHOT: {
      const messageId = getStringField(event, "messageId");
      const activityType = getStringField(event, "activityType");
      const content = getObjectField(event, "content");
      if (!messageId || !activityType || !content) {
        return malformedNativeRuntimeEvent(event);
      }
      const key = getRuntimeActivityKey(messageId, activityType);
      const replace = getBooleanField(event, "replace") ?? true;
      const previousContent = state.runtimeActivities[key]?.content;
      return {
        runtimeState: state.runtimeState,
        runtimeActivities: {
          ...state.runtimeActivities,
          [key]: {
            messageId,
            activityType,
            content:
              replace || !previousContent
                ? { ...content }
                : { ...previousContent, ...content },
          },
        },
      };
    }
    case EventType.ACTIVITY_DELTA: {
      const messageId = getStringField(event, "messageId");
      const activityType = getStringField(event, "activityType");
      const patch = getArrayField(event, "patch");
      if (!messageId || !activityType || !patch) {
        return malformedNativeRuntimeEvent(event);
      }
      const key = getRuntimeActivityKey(messageId, activityType);
      const previous = state.runtimeActivities[key];
      const content = applyJsonPatchOperations(previous?.content ?? {}, patch);
      if (!content) {
        return malformedNativeRuntimeEvent(event);
      }
      return {
        runtimeState: state.runtimeState,
        runtimeActivities: {
          ...state.runtimeActivities,
          [key]: { messageId, activityType, content },
        },
      };
    }
    default:
      return null;
  }
}

function malformedNativeRuntimeEvent(event: BaseEvent): {
  quarantineEntry: ThreadViewQuarantineEntry;
} {
  return {
    quarantineEntry: {
      reason: "malformed-native-runtime-event",
      eventType: String(event.type),
    },
  };
}

function getRuntimeActivityKey(
  messageId: string,
  activityType: string,
): string {
  return `${encodeURIComponent(messageId)}:${encodeURIComponent(activityType)}`;
}
