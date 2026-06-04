/**
 * Cross-module guard for the instant-optimistic-submit seam.
 *
 * The bug: a follow-up via the runtime.append branch returns without flipping
 * the thread status, so the client-derived `isAgentWorking` stays false, the
 * resume policy resolves to `idle-finalized` / `clear`, and the resume stream
 * never opens — the UI is frozen until a manual refresh.
 *
 * The fix (behind the `instantOptimisticSubmit` flag): the optimistic submit is
 * hoisted above the composer routing fork and flips the reducer to `booting`.
 * `booting` is in PRIMARY_CHAT_LIVE_THREAD_STATUSES, so `isAgentWorking` goes
 * true on the same commit and the resume policy resolves to `active-resume` /
 * `apply-history-last-seq` — opening the stream with no refresh.
 *
 * This test drives the production seam directly — the real reducer, the real
 * `isAgentWorking` predicate, and the real `resolveRuntimeResumePolicy` — rather
 * than mounting the full TipTap composer under jsdom. It is pure: no jsdom, no
 * network, no feature-flag mock (the flag only decides whether the flip fires;
 * here we exercise the flip's downstream effect, which is what no single
 * assertion holds today).
 */

import type { DBMessage, DBUserMessage } from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import { describe, expect, it } from "vitest";
import { isAgentWorking } from "@/agent/thread-status";
import { resolveRuntimeResumePolicy } from "@/components/chat/assistant-ui/runtime-resume-policy";
import {
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "@/components/chat/thread-view-model/reducer";
import { createThreadViewSnapshot } from "@/components/chat/thread-view-model/snapshot-adapter";
import type { ThreadViewSnapshot } from "@/components/chat/thread-view-model/types";

function userMessage(text: string): DBUserMessage {
  return {
    type: "user",
    model: null,
    parts: [{ type: "text", text }],
  };
}

function idleChat(messages: DBMessage[]): ThreadPageChat {
  return {
    id: "chat-xyz",
    userId: "user-1",
    threadId: "thread-abc",
    title: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    agent: "codex",
    agentVersion: 1,
    status: "complete",
    projectedMessages: messages,
    isCanonicalProjection: false,
    queuedMessages: null,
    sessionId: null,
    errorMessage: null,
    errorMessageInfo: null,
    scheduleAt: null,
    reattemptQueueAt: null,
    contextLength: null,
    permissionMode: "allowAll",
    codexPreviousResponseId: null,
    messageSeq: messages.length,
    messageCount: messages.length,
    chatSequence: null,
    patchVersion: null,
    isUnread: false,
  };
}

function idleSnapshot(messages: DBMessage[]): ThreadViewSnapshot {
  return createThreadViewSnapshot({
    threadChat: idleChat(messages),
    agent: "codex",
    source: "collection",
    artifactThread: {
      id: "thread-abc",
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      gitDiff: null,
      gitDiffStats: null,
    },
    githubSummary: {
      prStatus: null,
      prChecksStatus: null,
      githubPRNumber: null,
      githubRepoFullName: "",
    },
  });
}

/** Mirrors chat-ui.tsx: isAgentCurrentlyWorking derives from the projected
 *  lifecycle.threadStatus through the production isAgentWorking predicate. */
function deriveIsAgentWorking(
  status: ReturnType<
    typeof projectThreadViewModel
  >["lifecycle"]["threadStatus"],
): boolean {
  return status !== null && isAgentWorking(status);
}

describe("instant optimistic resume seam", () => {
  it("an idle finalized thread resolves to a closed (non-resuming) stream", () => {
    const state = createInitialThreadViewModelState(
      idleSnapshot([userMessage("hi")]),
    );
    const status = projectThreadViewModel(state).lifecycle.threadStatus;
    const working = deriveIsAgentWorking(status);

    expect(working).toBe(false);

    const policy = resolveRuntimeResumePolicy({
      isAgentWorking: working,
      threadChatId: "chat-xyz",
    });
    // The deadlock: idle => the resume stream is never opened.
    expect(policy.historyMode).toBe("idle-finalized");
    expect(policy.replayCursorAction).toBe("clear");
  });

  it("the optimistic booting flip flips isAgentWorking true and opens the resume stream without a refresh", () => {
    const state = threadViewModelReducer(
      createInitialThreadViewModelState(idleSnapshot([userMessage("hi")])),
      {
        type: "optimistic.user-submitted",
        message: userMessage("follow up"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-resume-1",
      },
    );
    const status = projectThreadViewModel(state).lifecycle.threadStatus;
    const working = deriveIsAgentWorking(status);

    expect(status).toBe("booting");
    expect(working).toBe(true);

    const policy = resolveRuntimeResumePolicy({
      isAgentWorking: working,
      threadChatId: "chat-xyz",
    });
    // The fix: booting => active resume, cursor applied, no refresh needed.
    expect(policy.historyMode).toBe("active-resume");
    expect(policy.replayCursorAction).toBe("apply-history-last-seq");
  });

  it("a rejection reverts isAgentWorking back to the closed-stream baseline", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(idleSnapshot([userMessage("hi")])),
      {
        type: "optimistic.user-submitted",
        message: userMessage("follow up"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-resume-2",
      },
    );
    expect(
      deriveIsAgentWorking(
        projectThreadViewModel(state).lifecycle.threadStatus,
      ),
    ).toBe(true);

    state = threadViewModelReducer(state, {
      type: "optimistic.user-submit-rejected",
      clientSubmissionId: "sub-resume-2",
    });
    const status = projectThreadViewModel(state).lifecycle.threadStatus;
    const working = deriveIsAgentWorking(status);

    expect(working).toBe(false);
    const policy = resolveRuntimeResumePolicy({
      isAgentWorking: working,
      threadChatId: "chat-xyz",
    });
    expect(policy.historyMode).toBe("idle-finalized");
  });
});
