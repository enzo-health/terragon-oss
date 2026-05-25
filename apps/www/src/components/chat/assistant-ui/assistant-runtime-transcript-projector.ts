import type {
  ThreadMessage,
  ThreadAssistantMessagePart,
  ThreadUserMessagePart,
} from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage, UIPart, UIUserMessage } from "@terragon/shared";
import type { UIPartExtended } from "../ui-parts-extended";
import {
  assistantPartToUIPart,
  userPartToUIPart,
} from "./runtime-part-conversion";
import {
  createRuntimeMessageSnapshot,
  sameRuntimeMessageSnapshot,
  sameRuntimePartSnapshot,
  type RuntimeMessageSnapshot,
  type RuntimePartSnapshot,
} from "./runtime-fingerprint";

type RuntimeTranscriptProjection = {
  source: "runtime";
  messages: UIMessage[];
};
type RuntimeProjectionCacheEntry = {
  snapshot: RuntimeMessageSnapshot;
  agent: AIAgent;
  projected: UIMessage | null;
  partSnapshots: RuntimePartSnapshot[];
  projectedParts: RuntimeProjectedPart[];
};
type RuntimeTranscriptProjector = (params: {
  runtimeMessages: readonly ThreadMessage[];
  agent: AIAgent;
}) => RuntimeTranscriptProjection;

type RuntimeProjectedPart =
  | UIPartExtended
  | UIUserMessage["parts"][number]
  | null;

function projectRuntimeMessage({
  message,
  agent,
  snapshot,
  cached,
}: {
  message: ThreadMessage;
  agent: AIAgent;
  snapshot: RuntimeMessageSnapshot;
  cached: RuntimeProjectionCacheEntry | undefined;
}): RuntimeProjectionCacheEntry {
  if (
    cached?.agent === agent &&
    sameRuntimeMessageSnapshot(cached.snapshot, snapshot)
  ) {
    return cached;
  }
  return runtimeMessageToUIMessageCached({ message, agent, snapshot, cached });
}

function runtimeMessageToUIMessageCached({
  message,
  agent,
  snapshot,
  cached,
}: {
  message: ThreadMessage;
  agent: AIAgent;
  snapshot: RuntimeMessageSnapshot;
  cached: RuntimeProjectionCacheEntry | undefined;
}): RuntimeProjectionCacheEntry {
  if (message.role === "system") {
    return {
      snapshot,
      agent,
      projected: null,
      partSnapshots: snapshot.parts,
      projectedParts: [],
    };
  }

  const canReuseCachedParts =
    cached?.agent === agent &&
    cached.snapshot.role === snapshot.role &&
    cached.partSnapshots.length === snapshot.parts.length;
  const projectedParts: RuntimeProjectedPart[] = [];

  for (let index = 0; index < message.content.length; index += 1) {
    const partSnapshot = snapshot.parts[index];
    if (!partSnapshot) continue;
    const cachedPartSnapshot = cached?.partSnapshots[index];
    if (
      canReuseCachedParts &&
      cachedPartSnapshot &&
      sameRuntimePartSnapshot(cachedPartSnapshot, partSnapshot)
    ) {
      projectedParts[index] = cached.projectedParts[index] ?? null;
      continue;
    }
    const part = message.content[index]!;
    projectedParts[index] =
      message.role === "user"
        ? userPartToUIPart(part as ThreadUserMessagePart)
        : assistantPartToUIPart(part as ThreadAssistantMessagePart, agent);
  }

  if (message.role === "user") {
    const parts: UIUserMessage["parts"] = [];
    for (const part of projectedParts) {
      if (part !== null) {
        parts.push(part as UIUserMessage["parts"][number]);
      }
    }
    return {
      snapshot,
      agent,
      projected: {
        id: message.id,
        role: "user",
        parts,
      },
      partSnapshots: snapshot.parts,
      projectedParts,
    };
  }

  const parts: UIPart[] = [];
  for (const part of projectedParts) {
    if (part !== null) {
      parts.push(part as UIPart);
    }
  }
  return {
    snapshot,
    agent,
    projected: {
      id: message.id,
      role: "agent",
      agent,
      parts,
    },
    partSnapshots: snapshot.parts,
    projectedParts,
  };
}

export function createAssistantRuntimeTranscriptProjector(): RuntimeTranscriptProjector {
  const cache = new Map<string, RuntimeProjectionCacheEntry>();
  let previousAgent: AIAgent | null = null;
  let previousRuntimeMessages: readonly ThreadMessage[] = [];
  let previousProjectedByRuntimeIndex: Array<UIMessage | null> = [];
  let previousCompactIndexByRuntimeIndex: number[] = [];
  let previousProjectedMessages: UIMessage[] = [];

  return ({ runtimeMessages, agent }) => {
    const canReusePrefix = previousAgent === agent;
    const firstChangedIndex = canReusePrefix
      ? getFirstChangedRuntimeMessageIndex(
          previousRuntimeMessages,
          runtimeMessages,
        )
      : 0;
    if (
      canUseTailProjectionFastPath({
        previousAgent,
        agent,
        previousRuntimeMessages,
        runtimeMessages,
        firstChangedIndex,
      })
    ) {
      const tailIndex = runtimeMessages.length - 1;
      const message = runtimeMessages[tailIndex]!;
      const cached = cache.get(message.id);
      const snapshot = createRuntimeMessageSnapshot(message);
      const nextCacheEntry = projectRuntimeMessage({
        message,
        agent,
        snapshot,
        cached,
      });
      const projected = nextCacheEntry.projected;
      const previousProjected = previousProjectedByRuntimeIndex[tailIndex];

      cache.set(message.id, nextCacheEntry);
      previousRuntimeMessages = runtimeMessages;

      if (projected === previousProjected) {
        return { source: "runtime", messages: previousProjectedMessages };
      }

      const compactIndex = previousCompactIndexByRuntimeIndex[tailIndex];
      previousProjectedByRuntimeIndex[tailIndex] = projected;

      if (compactIndex === undefined || compactIndex < 0) {
        return rebuildProjectedTranscriptState({
          runtimeMessages,
          projectedByRuntimeIndex: previousProjectedByRuntimeIndex,
          agent,
          cache,
          setState: (state) => {
            previousProjectedByRuntimeIndex = state.projectedByRuntimeIndex;
            previousCompactIndexByRuntimeIndex =
              state.compactIndexByRuntimeIndex;
            previousProjectedMessages = state.projectedMessages;
          },
        });
      }

      const nextProjectedMessages = previousProjectedMessages.slice();
      if (projected === null) {
        nextProjectedMessages.splice(compactIndex, 1);
      } else {
        nextProjectedMessages[compactIndex] = projected;
      }
      previousProjectedMessages = nextProjectedMessages;
      return { source: "runtime", messages: nextProjectedMessages };
    }

    const firstProjectedIndex =
      runtimeMessages.length > 0
        ? Math.min(firstChangedIndex, runtimeMessages.length - 1)
        : 0;
    const projectedByRuntimeIndex =
      firstProjectedIndex > 0
        ? previousProjectedByRuntimeIndex.slice(0, firstProjectedIndex)
        : [];
    const compactIndexByRuntimeIndex =
      firstProjectedIndex > 0
        ? previousCompactIndexByRuntimeIndex.slice(0, firstProjectedIndex)
        : [];
    let changed =
      previousAgent !== agent ||
      previousRuntimeMessages.length !== runtimeMessages.length;

    for (
      let index = firstProjectedIndex;
      index < runtimeMessages.length;
      index += 1
    ) {
      const message = runtimeMessages[index]!;
      const previousProjected = previousProjectedByRuntimeIndex[index];
      if (
        canReusePrefix &&
        index > firstChangedIndex &&
        previousRuntimeMessages[index] === message &&
        previousProjected !== undefined
      ) {
        projectedByRuntimeIndex[index] = previousProjected;
        continue;
      }

      const cached = cache.get(message.id);
      const snapshot = createRuntimeMessageSnapshot(message);
      const nextCacheEntry = projectRuntimeMessage({
        message,
        agent,
        snapshot,
        cached,
      });
      const projected = nextCacheEntry.projected;

      cache.set(message.id, nextCacheEntry);
      projectedByRuntimeIndex[index] = projected;
      if (projected !== previousProjectedByRuntimeIndex[index]) {
        changed = true;
      }
    }

    if (
      shouldPruneRuntimeProjectionCache(
        previousRuntimeMessages,
        runtimeMessages,
      )
    ) {
      pruneRuntimeProjectionCache(cache, runtimeMessages);
    }

    const projectedMessages: UIMessage[] = [];
    for (let index = 0; index < projectedByRuntimeIndex.length; index += 1) {
      const projected = projectedByRuntimeIndex[index] ?? null;
      if (projected !== null) {
        compactIndexByRuntimeIndex[index] = projectedMessages.length;
        projectedMessages.push(projected);
      } else {
        compactIndexByRuntimeIndex[index] = -1;
      }
    }

    if (
      !changed &&
      projectedMessages.length === previousProjectedMessages.length &&
      projectedMessages.every(
        (message, index) => message === previousProjectedMessages[index],
      )
    ) {
      return { source: "runtime", messages: previousProjectedMessages };
    }

    previousAgent = agent;
    previousRuntimeMessages = runtimeMessages;
    previousProjectedByRuntimeIndex = projectedByRuntimeIndex;
    previousCompactIndexByRuntimeIndex = compactIndexByRuntimeIndex;
    previousProjectedMessages = projectedMessages;
    return { source: "runtime", messages: projectedMessages };
  };
}

type ProjectedTranscriptState = {
  projectedByRuntimeIndex: Array<UIMessage | null>;
  compactIndexByRuntimeIndex: number[];
  projectedMessages: UIMessage[];
};

function canUseTailProjectionFastPath({
  previousAgent,
  agent,
  previousRuntimeMessages,
  runtimeMessages,
  firstChangedIndex,
}: {
  previousAgent: AIAgent | null;
  agent: AIAgent;
  previousRuntimeMessages: readonly ThreadMessage[];
  runtimeMessages: readonly ThreadMessage[];
  firstChangedIndex: number;
}): boolean {
  if (
    previousAgent !== agent ||
    runtimeMessages.length === 0 ||
    previousRuntimeMessages.length !== runtimeMessages.length
  ) {
    return false;
  }

  const tailIndex = runtimeMessages.length - 1;
  return (
    firstChangedIndex >= tailIndex &&
    previousRuntimeMessages[tailIndex]?.id === runtimeMessages[tailIndex]?.id
  );
}

function rebuildProjectedTranscriptState({
  runtimeMessages,
  projectedByRuntimeIndex,
  agent,
  cache,
  setState,
}: {
  runtimeMessages: readonly ThreadMessage[];
  projectedByRuntimeIndex: Array<UIMessage | null>;
  agent: AIAgent;
  cache: Map<string, RuntimeProjectionCacheEntry>;
  setState: (state: ProjectedTranscriptState) => void;
}): RuntimeTranscriptProjection {
  const nextProjectedByRuntimeIndex = projectedByRuntimeIndex.slice(
    0,
    runtimeMessages.length,
  );
  const compactIndexByRuntimeIndex: number[] = [];
  const projectedMessages: UIMessage[] = [];

  for (let index = 0; index < runtimeMessages.length; index += 1) {
    const message = runtimeMessages[index]!;
    let projected = nextProjectedByRuntimeIndex[index];
    if (projected === undefined) {
      const cached = cache.get(message.id);
      const snapshot = createRuntimeMessageSnapshot(message);
      const nextCacheEntry = projectRuntimeMessage({
        message,
        agent,
        snapshot,
        cached,
      });
      projected = nextCacheEntry.projected;
      cache.set(message.id, nextCacheEntry);
      nextProjectedByRuntimeIndex[index] = projected;
    }
    if (projected !== null) {
      compactIndexByRuntimeIndex[index] = projectedMessages.length;
      projectedMessages.push(projected);
    } else {
      compactIndexByRuntimeIndex[index] = -1;
    }
  }

  setState({
    projectedByRuntimeIndex: nextProjectedByRuntimeIndex,
    compactIndexByRuntimeIndex,
    projectedMessages,
  });
  return { source: "runtime", messages: projectedMessages };
}

function getFirstChangedRuntimeMessageIndex(
  previous: readonly ThreadMessage[],
  current: readonly ThreadMessage[],
): number {
  const sharedLength = Math.min(previous.length, current.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (previous[index] !== current[index]) {
      return index;
    }
  }
  return sharedLength;
}

function shouldPruneRuntimeProjectionCache(
  previous: readonly ThreadMessage[],
  current: readonly ThreadMessage[],
): boolean {
  if (current.length < previous.length) {
    return true;
  }
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index]?.id !== current[index]?.id) {
      return true;
    }
  }
  return false;
}

function pruneRuntimeProjectionCache(
  cache: Map<string, RuntimeProjectionCacheEntry>,
  runtimeMessages: readonly ThreadMessage[],
) {
  const liveIds = new Set(runtimeMessages.map((message) => message.id));
  for (const cachedId of cache.keys()) {
    if (!liveIds.has(cachedId)) {
      cache.delete(cachedId);
    }
  }
}
