import { useSyncExternalStore } from "react";
import type { TranscriptItem, TranscriptStore } from "../transcript-store";

export const STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS = 1;
export const STORE_FLAG_HAS_PENDING_TOOL_CALL = 2;

export function getStoreThreadFlags(items: readonly TranscriptItem[]): number {
  let flags = 0;
  for (const item of items) {
    switch (item.kind) {
      case "text":
      case "reasoning":
        if (item.text.trim().length > 0) {
          flags |= STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS;
        }
        break;
      case "tool":
        flags |= STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS;
        if (item.result === null) flags |= STORE_FLAG_HAS_PENDING_TOOL_CALL;
        break;
      case "terminal":
        flags |= STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS;
        if (item.exitCode === null) flags |= STORE_FLAG_HAS_PENDING_TOOL_CALL;
        break;
      case "delegation":
        flags |= STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS;
        if (item.status === "running") {
          flags |= STORE_FLAG_HAS_PENDING_TOOL_CALL;
        }
        break;
      case "diff":
      case "plan":
      case "sources":
      case "image":
      case "attachment":
        flags |= STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS;
        break;
      case "permission":
        if (item.status === "pending") {
          flags |= STORE_FLAG_HAS_PENDING_TOOL_CALL;
        }
        break;
      default:
        break;
    }
  }
  return flags;
}

export type StoreThreadFlags = {
  hasRenderableAgentParts: boolean;
  hasPendingToolCall: boolean;
};

export function useStoreThreadFlags(store: TranscriptStore): StoreThreadFlags {
  const flags = useSyncExternalStore(
    store.subscribe,
    () => getStoreThreadFlags(store.getItems()),
    () => 0,
  );
  return {
    hasRenderableAgentParts:
      (flags & STORE_FLAG_HAS_RENDERABLE_AGENT_PARTS) !== 0,
    hasPendingToolCall: (flags & STORE_FLAG_HAS_PENDING_TOOL_CALL) !== 0,
  };
}
