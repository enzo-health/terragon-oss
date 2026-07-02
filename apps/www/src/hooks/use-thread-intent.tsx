"use client";

import type { DBUserMessage } from "@terragon/shared";
import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";

export type ThreadIntent =
  | {
      type: "send-message";
      threadId: string;
      threadChatId: string;
      message: DBUserMessage;
      // Threaded from the composer's routeComposerSubmit so this fallback path
      // shares the AG-UI append path's per-submission idempotency dedupe.
      clientSubmissionId?: string | null;
    }
  | {
      type: "queue-message";
      threadId: string;
      threadChatId: string;
      messages: DBUserMessage[];
    }
  | { type: "stop-thread"; threadId: string; threadChatId: string }
  | { type: "fix-checks"; threadId: string; threadChatId: string }
  | { type: "open-pr"; threadId: string; prType?: "draft" | "ready" }
  | { type: "mark-pr-ready"; threadId: string }
  | { type: "archive-thread"; threadId: string; archive: boolean }
  | {
      type: "redo-task";
      threadId: string;
      userMessage: DBUserMessage;
      repoFullName: string;
      branchName: string;
      disableGitCheckpointing?: boolean;
      skipSetup?: boolean;
      skipArchiving?: boolean;
    }
  | {
      type: "fork-task";
      threadId: string;
      threadChatId: string;
      userMessage: DBUserMessage;
      repoFullName: string;
      branchName: string;
      disableGitCheckpointing?: boolean;
      skipSetup?: boolean;
      createNewBranch?: boolean;
    }
  | { type: "copy-git-diff"; threadId: string };

export type ThreadIntentSubscriber = (intent: ThreadIntent) => Promise<void>;

export type ThreadIntentBus = {
  publish: (intent: ThreadIntent) => Promise<void>;
};

const ThreadIntentContext = createContext<ThreadIntentBus | null>(null);

export function ThreadIntentProvider({
  children,
  subscriber,
}: {
  children: ReactNode;
  subscriber: ThreadIntentSubscriber;
}) {
  const publish = useCallback(
    async (intent: ThreadIntent) => subscriber(intent),
    [subscriber],
  );

  const value = useMemo(() => ({ publish }), [publish]);

  return (
    <ThreadIntentContext.Provider value={value}>
      {children}
    </ThreadIntentContext.Provider>
  );
}

export function useThreadIntent(): ThreadIntentBus {
  const ctx = useContext(ThreadIntentContext);
  if (!ctx) {
    throw new Error(
      "useThreadIntent must be used within a ThreadIntentProvider",
    );
  }
  return ctx;
}
