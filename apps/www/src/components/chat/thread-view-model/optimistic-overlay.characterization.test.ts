// Phase-0 characterization gate for the optimistic-overlay-registry refactor
// (P1-C). These assertions pin the OBSERVABLE behavior of the optimistic
// preserve/rollback/no-op contract through `projectThreadViewModel` plus the
// reference-equality no-op contracts. They survive the internal field rename
// (the 4 flags + optimisticSubmission -> optimisticOverlay struct) because they
// never read the removed fields directly except via the new
// `pendingClientSubmissionId` selector.
//
// SEQUENCING: land the projection field (pendingClientSubmissionId) as the very
// first edit, then land this file GREEN against the pre-refactor reducer, THEN
// perform the refactor. The pendingClientSubmissionId assertions require that
// projection field; everything else is green on un-refactored main.
import { type BaseEvent, EventType } from "@ag-ui/core";
import type { DBMessage, DBUserMessage } from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import { describe, expect, it } from "vitest";
import {
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "./reducer";
import { createThreadViewSnapshot } from "./snapshot-adapter";
import type { ThreadViewModelState, ThreadViewSnapshot } from "./types";

describe("optimistic overlay characterization (P1-C gate)", () => {
  it("exposes the in-flight clientSubmissionId via the projection selector", () => {
    const state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWith([userMessage("hi")])),
      submit("next", "booting", "sub-1"),
    );
    expect(projectThreadViewModel(state).pendingClientSubmissionId).toBe(
      "sub-1",
    );
  });

  it("clears the in-flight clientSubmissionId after authoritative status adoption", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWith([userMessage("hi")])),
      submit("next", "booting", "sub-2"),
    );
    state = applyAgUi(state, statusChanged("working"));
    expect(projectThreadViewModel(state).threadStatus).toBe("working");
    expect(projectThreadViewModel(state).pendingClientSubmissionId).toBeNull();
  });

  it("keeps the in-flight clientSubmissionId null when there is no submit", () => {
    const state = createInitialThreadViewModelState(snapshotWith([]));
    expect(projectThreadViewModel(state).pendingClientSubmissionId).toBeNull();
  });

  it("preserves an optimistic submit (transcript + status + side panel) across snapshot.hydrated", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWith([userMessage("hi")])),
      submit("optimistic", "booting", "sub-3"),
    );
    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWith([userMessage("hi")]),
    });
    const vm = projectThreadViewModel(state);
    expect(vm.threadStatus).toBe("booting");
    expect(vm.dbMessages).toHaveLength(2);
    expect(vm.sidePanel.messages).toHaveLength(2);
    expect(vm.pendingClientSubmissionId).toBe("sub-3");
  });

  it("replaces optimistic transcript/status on server.refetch-reconciled", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWith([userMessage("hi")])),
      submit("stale", "booting", "sub-4"),
    );
    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWith([userMessage("hi")]),
    });
    const vm = projectThreadViewModel(state);
    expect(vm.threadStatus).toBe("complete");
    expect(vm.dbMessages).toHaveLength(1);
    expect(vm.sidePanel.messages).toHaveLength(1);
    expect(vm.pendingClientSubmissionId).toBeNull();
  });

  it("COEXISTENCE: preserves queued AND submit overlays together across hydration, then clears both on reconcile", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWith([userMessage("hi")])),
      submit("optimistic", "booting", "sub-5"),
    );
    state = threadViewModelReducer(state, {
      type: "optimistic.queued-messages-updated",
      messages: [userMessage("queued")],
    });

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWith([userMessage("hi")]),
    });
    let vm = projectThreadViewModel(state);
    expect(vm.queuedMessages).toEqual([userMessage("queued")]);
    expect(vm.sidePanel.messages).toHaveLength(2);
    expect(vm.pendingClientSubmissionId).toBe("sub-5");

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWith([userMessage("hi")]),
    });
    vm = projectThreadViewModel(state);
    expect(vm.queuedMessages).toBeNull();
    expect(vm.sidePanel.messages).toHaveLength(1);
    expect(vm.pendingClientSubmissionId).toBeNull();
  });

  it("COEXISTENCE: an authoritative status change clears the submit slot but keeps the queued overlay", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWith([userMessage("hi")])),
      submit("optimistic", "booting", "sub-6"),
    );
    state = threadViewModelReducer(state, {
      type: "optimistic.queued-messages-updated",
      messages: [userMessage("queued")],
    });
    state = applyAgUi(state, statusChanged("working"));

    // Submit correlation is gone after authoritative adoption...
    expect(projectThreadViewModel(state).pendingClientSubmissionId).toBeNull();
    // ...but the queued overlay must survive the status flip across hydration.
    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWith([userMessage("hi")]),
    });
    expect(projectThreadViewModel(state).queuedMessages).toEqual([
      userMessage("queued"),
    ]);
  });

  it("preserves optimistic permission mode across hydration until durable reconciliation", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWith([userMessage("hi")], { permissionMode: "allowAll" }),
      ),
      { type: "optimistic.permission-mode-updated", permissionMode: "plan" },
    );
    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWith([userMessage("hi")], {
        permissionMode: "allowAll",
      }),
    });
    expect(projectThreadViewModel(state).permissionMode).toBe("plan");

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWith([userMessage("hi")], {
        permissionMode: "allowAll",
      }),
    });
    expect(projectThreadViewModel(state).permissionMode).toBe("allowAll");
  });

  it("reverts the submit on a matching rejection and clears the correlation id", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWith([userMessage("hi")])),
      submit("next", "booting", "sub-7"),
    );
    state = threadViewModelReducer(state, {
      type: "optimistic.user-submit-rejected",
      clientSubmissionId: "sub-7",
    });
    const vm = projectThreadViewModel(state);
    expect(vm.threadStatus).toBe("complete");
    expect(vm.dbMessages).toHaveLength(1);
    expect(vm.sidePanel.messages).toHaveLength(1);
    expect(vm.pendingClientSubmissionId).toBeNull();
  });

  it("no-ops a mismatched rejection by reference", () => {
    const before = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWith([userMessage("hi")])),
      submit("next", "booting", "sub-keep"),
    );
    const after = threadViewModelReducer(before, {
      type: "optimistic.user-submit-rejected",
      clientSubmissionId: "sub-other",
    });
    expect(after).toBe(before);
  });

  it("NO-OP FAST PATH: a value-equal re-hydration with no optimistic/live state returns the same state object", () => {
    // Pins the reference-equality short-circuit the roadmap flags as fragile.
    // CAVEAT: createThreadViewSnapshot builds fresh arrays each call, so a fresh
    // snapshot is NOT a reference no-op. We hydrate with the SAME snapshot object
    // the state was initialized from to exercise the true no-op path.
    const snapshot = snapshotWith([userMessage("hi")]);
    const initial = createInitialThreadViewModelState(snapshot);
    const after = threadViewModelReducer(initial, {
      type: "snapshot.hydrated",
      snapshot,
    });
    expect(after).toBe(initial);
  });
});

function submit(
  text: string,
  optimisticStatus: "booting" | "working",
  clientSubmissionId: string,
) {
  return {
    type: "optimistic.user-submitted" as const,
    message: userMessage(text),
    optimisticStatus,
    clientSubmissionId,
  };
}

function statusChanged(status: string): BaseEvent {
  return {
    type: EventType.CUSTOM,
    name: "thread.status_changed",
    value: { status },
  } as BaseEvent;
}

function applyAgUi(
  state: ThreadViewModelState,
  event: BaseEvent,
): ThreadViewModelState {
  return threadViewModelReducer(state, { type: "ag-ui.event", event });
}

function snapshotWith(
  dbMessages: DBMessage[],
  overrides: { permissionMode?: ThreadPageChat["permissionMode"] } = {},
): ThreadViewSnapshot {
  return createThreadViewSnapshot({
    threadChat: threadPageChat({
      messages: dbMessages,
      permissionMode: overrides.permissionMode,
    }),
    agent: "claudeCode",
    source: "collection",
    artifactThread: {
      id: "thread-1",
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

function userMessage(text: string): DBUserMessage {
  return { type: "user", model: null, parts: [{ type: "text", text }] };
}

function threadPageChat({
  messages,
  permissionMode = "allowAll",
}: {
  messages: DBMessage[];
  permissionMode?: ThreadPageChat["permissionMode"];
}): ThreadPageChat {
  return {
    id: "chat-1",
    userId: "user-1",
    threadId: "thread-1",
    title: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    agent: "claudeCode",
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
    permissionMode,
    codexPreviousResponseId: null,
    messageSeq: messages.length,
    messageCount: messages.length,
    chatSequence: null,
    patchVersion: null,
    isUnread: false,
  };
}
