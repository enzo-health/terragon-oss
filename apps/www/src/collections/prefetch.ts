"use client";

import { getThreadShellCollection, seedShell } from "./thread-shell-collection";
import { seedChat } from "./thread-chat-collection";
import { getThreadPageShellAction } from "@/server-actions/get-thread-page-shell";
import { getThreadPageChatAction } from "@/server-actions/get-thread-page-chat";
import { unwrapResult } from "@/lib/server-actions";

const inflight = new Set<string>();

/** Prefetch thread shell + chat into collections on hover for instant switching. */
export function prefetchThreadIntoCollections(threadId: string): void {
  const shellCollection = getThreadShellCollection();
  if (shellCollection.status === "ready" && shellCollection.state.has(threadId))
    return;
  if (inflight.has(threadId)) return;
  inflight.add(threadId);

  getThreadPageShellAction(threadId)
    .then((result) => {
      const shell = unwrapResult(result);
      seedShell(shell);
      if (shell.primaryThreadChatId) {
        return getThreadPageChatAction({
          threadId,
          threadChatId: shell.primaryThreadChatId,
        }).then((chatResult) => seedChat(unwrapResult(chatResult)));
      }
    })
    .catch((err) => console.warn("[prefetch] failed for thread", threadId, err))
    .finally(() => inflight.delete(threadId));
}
