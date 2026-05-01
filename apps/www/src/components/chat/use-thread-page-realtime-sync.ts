"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import { useCallback } from "react";
import { applyChatPatchToCollection } from "@/collections/thread-chat-collection";
import { applyShellPatchToCollection } from "@/collections/thread-shell-collection";
import { useRealtimeThreadMatch } from "@/hooks/useRealtime";
import { threadQueryKeys } from "@/queries/thread-queries";

// Subscribes the active thread page to broadcast patches and routes them into
// the shell + chat collections. Without this, status flips, queued-message
// changes, and sandbox state updates only land after a full reload — the
// chat-collection patch helpers were left without a consumer when the runtime
// rewrite (PR #153) replaced delta broadcasts with SSE.
//
// Mounted before the loading gate in ThreadProvider, so a patch arriving
// before the chat seed lands no-ops cleanly inside applyChatPatchToCollection
// (no existing row → drop). The seed query refetch picks up the latest
// state, so no queue-and-replay scaffolding is needed.
export function useThreadPageRealtimeSync({
  threadId,
}: {
  threadId: string;
}): void {
  const queryClient = useQueryClient();

  const matchThread = useCallback(
    (patch: BroadcastThreadPatch): boolean => patch.threadId === threadId,
    [threadId],
  );

  const onThreadChange = useCallback(
    (patches: BroadcastThreadPatch[]): void => {
      for (const patch of patches) {
        applyShellPatchToCollection(patch);

        const chatResult = patch.threadChatId
          ? applyChatPatchToCollection(patch)
          : { shouldInvalidate: false };

        if (chatResult.shouldInvalidate && patch.threadChatId) {
          queryClient.invalidateQueries({
            queryKey: threadQueryKeys.chat(patch.threadId, patch.threadChatId),
          });
        }

        for (const target of patch.refetch ?? []) {
          if (target === "shell") {
            queryClient.invalidateQueries({
              queryKey: threadQueryKeys.shell(patch.threadId),
            });
          } else if (target === "chat" && patch.threadChatId) {
            queryClient.invalidateQueries({
              queryKey: threadQueryKeys.chat(
                patch.threadId,
                patch.threadChatId,
              ),
            });
          } else if (target === "diff") {
            queryClient.invalidateQueries({
              queryKey: threadQueryKeys.diff(patch.threadId),
            });
          }
        }
      }
    },
    [queryClient],
  );

  useRealtimeThreadMatch({ matchThread, onThreadChange });
}
