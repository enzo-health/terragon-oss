import { readFileSync } from "node:fs";
import { type BaseEvent, EventType } from "@ag-ui/core";
import type { DBMessage, DBUserMessage, ThreadStatus } from "@terragon/shared";
import {
  buildRepoFileArtifactId,
  buildRepoTreeArtifactId,
} from "@terragon/shared/db/artifact-descriptors";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import { describe, expect, it } from "vitest";
import { dbMessagesToAgUiMessages } from "../db-messages-to-ag-ui";
import { toUIMessages } from "../toUIMessages";
import { createThreadViewSidecarEventProjector } from "../use-thread-view-model";
import {
  createInitialThreadViewModelState,
  OPTIMISTIC_SUBMIT_TTL_MS,
  projectThreadViewModel,
  threadViewModelReducer,
} from "./reducer";
import {
  createThreadViewSnapshot,
  selectThreadViewDbMessages,
} from "./snapshot-adapter";
import type {
  ThreadViewEvent,
  ThreadViewModelState,
  ThreadViewSnapshot,
} from "./types";

describe("ThreadViewModel reducer", () => {
  it("hydrates non-canonical DB snapshots through AG-UI replay only", () => {
    const dbMessages: DBMessage[] = [
      userMessage("hi"),
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "hello" }],
      },
    ];
    const chat = threadPageChat({ messages: dbMessages });

    const snapshot = createThreadViewSnapshot({
      threadChat: chat,
      agent: "claudeCode",
      source: "collection",
      artifactThread: artifactThread(),
      githubSummary: githubSummary(),
    });

    expect(snapshot.transcriptSource).toBe("ag-ui-replay");
    expect(snapshot.uiMessages).toEqual(
      toUIMessages({
        dbMessages,
        agent: "claudeCode",
        threadStatus: "complete",
      }),
    );
    expect(snapshot.agUiInitialMessages).toEqual(
      dbMessagesToAgUiMessages(dbMessages, { includeAssistantHistory: true }),
    );
  });

  it("uses canonical projected messages without legacy user-turn scaffolding", () => {
    const legacyUser = userMessage("please fix this");
    const projectedAgent: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text: "fixed" }],
    };
    const chat = threadPageChat({
      messages: [legacyUser],
      projectedMessages: [projectedAgent],
      isCanonicalProjection: true,
    });

    expect(selectThreadViewDbMessages(chat).dbMessages).toEqual([
      projectedAgent,
    ]);
  });

  it("keeps canonical projected message order independent of legacy message order", () => {
    const legacyUser1 = userMessage("first");
    const legacyUser2 = userMessage("second");
    const projectedUser2 = userMessage("canonical second");
    const projectedAgent1: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text: "first answer" }],
    };
    const projectedAgent2: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text: "second answer" }],
    };
    const chat = threadPageChat({
      messages: [legacyUser1, projectedAgent1, legacyUser2, projectedAgent2],
      projectedMessages: [projectedAgent1, projectedUser2, projectedAgent2],
      isCanonicalProjection: true,
    });

    expect(selectThreadViewDbMessages(chat).dbMessages).toEqual([
      projectedAgent1,
      projectedUser2,
      projectedAgent2,
    ]);
  });

  it("does not fall back to legacy messages for canonical snapshots with no projection", () => {
    const legacyUser = userMessage(
      "legacy should not scaffold canonical replay",
    );
    const chat = threadPageChat({
      messages: [legacyUser],
      projectedMessages: [],
      isCanonicalProjection: true,
    });

    const selected = selectThreadViewDbMessages(chat);
    expect(selected.dbMessages).toEqual([]);
    expect(selected.hasCanonicalProjectionSeed).toBe(false);
  });

  it("treats canonical-only projected snapshots as canonical seeds", () => {
    const projectedAgent: DBMessage = {
      type: "agent",
      parent_tool_use_id: null,
      parts: [{ type: "text", text: "canonical only" }],
    };
    const chat = threadPageChat({
      messages: [],
      projectedMessages: [projectedAgent],
      isCanonicalProjection: true,
    });

    const selected = selectThreadViewDbMessages(chat);
    expect(selected.dbMessages).toEqual([projectedAgent]);
    expect(selected.hasCanonicalProjectionSeed).toBe(true);

    const snapshot = createThreadViewSnapshot({
      threadChat: chat,
      agent: "claudeCode",
      source: "collection",
      artifactThread: artifactThread(),
      githubSummary: githubSummary(),
    });
    expect(snapshot.uiMessages).toHaveLength(0);
    expect(snapshot.agUiInitialMessages).toEqual([]);
  });

  it("keeps native AG UI replay out of the sidecar transcript projection", () => {
    const legacyUser = userMessage("legacy should not render");
    const snapshot = createThreadViewSnapshot({
      threadChat: threadPageChat({
        messages: [legacyUser],
        projectedMessages: [],
        isCanonicalProjection: true,
      }),
      agent: "claudeCode",
      source: "collection",
      artifactThread: artifactThread(),
      githubSummary: githubSummary(),
    });

    expect(snapshot.transcriptSource).toBe("ag-ui-replay");
    expect(snapshot.uiMessages).toEqual([]);
    expect(snapshot.agUiInitialMessages).toEqual([]);
    expect(snapshot.dbMessages).toEqual([]);

    let state = createInitialThreadViewModelState(snapshot);
    const initialState = state;
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "native-msg-1",
      role: "assistant",
    });
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "native-msg-1",
      delta: "rendered from replay",
    });

    expect(state).toBe(initialState);
  });

  it("hydrates DB snapshot while leaving duplicate replay bubbles to assistant-ui", () => {
    const snapshot = snapshotWithMessages([
      userMessage("hi"),
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [{ type: "text", text: "hello" }],
      },
    ]);
    let state = createInitialThreadViewModelState(snapshot);

    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg_abc123",
      role: "assistant",
    });
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg_abc123",
      delta: "hello",
    });

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.dbMessages.map((message) => message.type)).toEqual([
      "user",
      "agent",
    ]);
    expect(viewModel.sidePanel.messages.map((message) => message.type)).toEqual(
      ["user", "agent"],
    );
  });

  it("adds optimistic user submit to durable sidecar state only", () => {
    const state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-existing-1",
      },
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.threadStatus).toBe("booting");
    expect(viewModel.dbMessages).toHaveLength(2);
    expect(viewModel.dbMessages[1]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "next" }],
    });
    expect(viewModel.sidePanel.messages[1]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "next" }],
    });
  });

  it("keeps optimistic user submit off the legacy toUIMessages adapter", () => {
    const reducerSource = readFileSync(
      new URL("./reducer.ts", import.meta.url),
      "utf8",
    );

    expect(reducerSource).not.toContain("../toUIMessages");
  });

  it("replaces stale optimistic transcript and status on server refetch reconciliation", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("stale optimistic"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-existing-2",
      },
    );

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWithMessages([userMessage("hi")]),
    });

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.threadStatus).toBe("complete");
    expect(viewModel.lifecycle).toMatchObject({
      threadStatus: "complete",
      runStarted: false,
    });
    expect(viewModel.dbMessages).toHaveLength(1);
    expect(viewModel.dbMessages[0]).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(viewModel.sidePanel.messages).toHaveLength(1);
  });

  it("keeps optimistic 'booting' across a stale-complete snapshot.hydrated, then yields to authoritative reconcile", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-guard-1",
      },
    );
    expect(projectThreadViewModel(state).lifecycle.threadStatus).toBe(
      "booting",
    );

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")]),
    });
    let viewModel = projectThreadViewModel(state);
    expect(viewModel.threadStatus).toBe("booting");
    expect(viewModel.lifecycle.threadStatus).toBe("booting");

    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: { status: "working" },
      } as BaseEvent,
    });
    viewModel = projectThreadViewModel(state);
    expect(viewModel.threadStatus).toBe("working");
    expect(viewModel.lifecycle.threadStatus).toBe("working");
  });

  it("lets an authoritative RUN_FINISHED override and clear the optimistic latch", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-terminal-1",
        at: 1_000,
      },
    );
    expect(state.optimisticOverlay.userSubmit).not.toBeNull();

    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: { type: EventType.RUN_FINISHED } as BaseEvent,
    });
    expect(projectThreadViewModel(state).threadStatus).toBe("complete");
    expect(state.optimisticOverlay.userSubmit).toBeNull();
    expect(state.optimisticOverlay.userSubmit).toBeNull();
    expect(state.optimisticOverlay.userSubmit).toBeNull();

    // With the optimistic latch cleared, an authoritative reconcile yields
    // straight to the snapshot's DB status — no stale optimistic status remains.
    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWithMessages([userMessage("hi")], { status: "error" }),
    });
    expect(projectThreadViewModel(state).threadStatus).toBe("error");
  });

  it("lets an authoritative terminal thread.status_changed clear the optimistic latch", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-terminal-2",
        at: 1_000,
      },
    );

    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: { status: "stopped" },
      } as BaseEvent,
    });

    expect(projectThreadViewModel(state).threadStatus).toBe("stopped");
    expect(state.optimisticOverlay.userSubmit).toBeNull();
    expect(state.optimisticOverlay.userSubmit).toBeNull();
  });

  it("reverts an unconfirmed optimistic latch to the terminal snapshot status after the TTL", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-ttl-1",
        at: 1_000,
      },
    );
    expect(projectThreadViewModel(state).threadStatus).toBe("booting");

    // Within the TTL: a stale-complete snapshot.hydrated does NOT revert.
    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")], {
        status: "complete",
      }),
      at: 1_000 + OPTIMISTIC_SUBMIT_TTL_MS,
    });
    expect(projectThreadViewModel(state).threadStatus).toBe("booting");

    // Past the TTL with a terminal DB status: revert to the authoritative status.
    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")], {
        status: "complete",
      }),
      at: 1_000 + OPTIMISTIC_SUBMIT_TTL_MS + 1,
    });
    const viewModel = projectThreadViewModel(state);
    expect(viewModel.threadStatus).toBe("complete");
    expect(viewModel.lifecycle.threadStatus).toBe("complete");
    expect(state.optimisticOverlay.userSubmit).toBeNull();
    expect(state.optimisticOverlay.userSubmit).toBeNull();
  });

  it("does not revert a slow-to-boot optimistic latch when the snapshot DB status is still live", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-boot-1",
        at: 1_000,
      },
    );

    // Well past the TTL, but the DB confirms a live `booting` — keep the latch.
    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")], {
        status: "booting",
      }),
      at: 1_000 + OPTIMISTIC_SUBMIT_TTL_MS * 10,
    });

    expect(projectThreadViewModel(state).threadStatus).toBe("booting");
    expect(state.optimisticOverlay.userSubmit).not.toBeNull();
    expect(state.optimisticOverlay.userSubmit?.pendingSince).toBe(1_000);
  });

  it("does not revert the optimistic latch on a stale-complete snapshot.hydrated with no timestamp", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-no-at",
        at: 1_000,
      },
    );

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")], {
        status: "complete",
      }),
    });

    expect(projectThreadViewModel(state).threadStatus).toBe("booting");
    expect(state.optimisticOverlay.userSubmit).not.toBeNull();
  });

  it("reverts the optimistic submit on rejection and clears the optimistic flag", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-reject-1",
      },
    );
    expect(projectThreadViewModel(state).lifecycle.threadStatus).toBe(
      "booting",
    );

    state = threadViewModelReducer(state, {
      type: "optimistic.user-submit-rejected",
      clientSubmissionId: "sub-reject-1",
    });
    const viewModel = projectThreadViewModel(state);
    expect(viewModel.threadStatus).toBe("complete");
    expect(viewModel.lifecycle).toMatchObject({
      threadStatus: "complete",
      runStarted: false,
    });
    expect(viewModel.dbMessages).toHaveLength(1);
    expect(viewModel.sidePanel.messages).toHaveLength(1);
    expect(state.optimisticOverlay.userSubmit).toBeNull();
  });

  it("no-ops a rejection whose clientSubmissionId does not match the pending submit", () => {
    const before = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-keep",
      },
    );
    const after = threadViewModelReducer(before, {
      type: "optimistic.user-submit-rejected",
      clientSubmissionId: "sub-other",
    });
    expect(after).toBe(before);
  });

  it("projects threadStatus from lifecycle across submit/reject/run events", () => {
    let state = createInitialThreadViewModelState(
      snapshotWithMessages([userMessage("hi")]),
    );
    const projectedStatus = () => projectThreadViewModel(state).threadStatus;
    expect(projectedStatus()).toBe(state.lifecycle.threadStatus);
    state = threadViewModelReducer(state, {
      type: "optimistic.user-submitted",
      message: userMessage("go"),
      optimisticStatus: "booting",
      clientSubmissionId: "sub-inv-1",
    });
    expect(projectedStatus()).toBe("booting");
    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.CUSTOM,
        name: "thread.status_changed",
        value: { status: "working" },
      } as BaseEvent,
    });
    expect(projectedStatus()).toBe("working");
    state = threadViewModelReducer(state, {
      type: "optimistic.user-submit-rejected",
      clientSubmissionId: "sub-inv-1",
    });
    expect(projectedStatus()).toBe(state.lifecycle.threadStatus);
  });

  it("preserves optimistic permission mode across hydration until durable reconciliation", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")], {
          permissionMode: "allowAll",
        }),
      ),
      {
        type: "optimistic.permission-mode-updated",
        permissionMode: "plan",
      },
    );

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")], {
        permissionMode: "allowAll",
      }),
    });
    expect(projectThreadViewModel(state).permissionMode).toBe("plan");

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWithMessages([userMessage("hi")], {
        permissionMode: "allowAll",
      }),
    });
    expect(projectThreadViewModel(state).permissionMode).toBe("allowAll");
  });

  it("opens a repo-file descriptor into artifacts, deduped by path+ref", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));

    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "src/foo.ts",
      ref: "feature-branch",
    });
    const opened = projectThreadViewModel(state).artifacts.descriptors;
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      id: buildRepoFileArtifactId({
        path: "src/foo.ts",
        ref: "feature-branch",
      }),
      kind: "repo-file",
      title: "foo.ts",
    });

    const before = state.artifacts;
    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "src/foo.ts",
      ref: "feature-branch",
    });
    expect(state.artifacts).toBe(before);
    expect(projectThreadViewModel(state).artifacts.descriptors).toHaveLength(1);

    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "src/foo.ts",
      ref: "other-branch",
    });
    expect(projectThreadViewModel(state).artifacts.descriptors).toHaveLength(2);
  });

  it("opens a single repo-tree descriptor, deduped by ref", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));

    state = threadViewModelReducer(state, {
      type: "repo-tree.opened",
      ref: "feature-branch",
    });
    const opened = projectThreadViewModel(state).artifacts.descriptors;
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      id: buildRepoTreeArtifactId({ ref: "feature-branch" }),
      kind: "repo-tree",
      title: "Files",
    });

    // Re-opening the same ref focuses the existing tab, not a duplicate.
    const before = state.artifacts;
    state = threadViewModelReducer(state, {
      type: "repo-tree.opened",
      ref: "feature-branch",
    });
    expect(state.artifacts).toBe(before);
    expect(projectThreadViewModel(state).artifacts.descriptors).toHaveLength(1);

    // A different ref is a distinct tree.
    state = threadViewModelReducer(state, {
      type: "repo-tree.opened",
      ref: "other-branch",
    });
    expect(projectThreadViewModel(state).artifacts.descriptors).toHaveLength(2);
  });

  it("preserves an opened repo-tree descriptor across snapshot hydration", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      { type: "repo-tree.opened", ref: "feature-branch" },
    );

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")]),
    });

    expect(
      projectThreadViewModel(state).artifacts.descriptors.map((d) => d.id),
    ).toContain(buildRepoTreeArtifactId({ ref: "feature-branch" }));
  });

  it("preserves an opened repo-file descriptor across snapshot hydration", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      { type: "repo-file.opened", path: "src/foo.ts", ref: "feature-branch" },
    );

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")]),
    });

    expect(
      projectThreadViewModel(state).artifacts.descriptors.map((d) => d.id),
    ).toContain(
      buildRepoFileArtifactId({ path: "src/foo.ts", ref: "feature-branch" }),
    );
  });

  it("preserves live lifecycle across hydration until durable reconciliation", () => {
    let state = applyRuntimeEvent(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      { type: EventType.RUN_STARTED, runId: "run-1" },
    );

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")]),
    });
    expect(projectThreadViewModel(state).lifecycle).toMatchObject({
      threadStatus: "working",
      runStarted: true,
    });

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWithMessages([userMessage("hi")]),
    });
    expect(projectThreadViewModel(state).lifecycle).toMatchObject({
      threadStatus: "complete",
      runStarted: false,
    });
  });

  it("allows durable snapshot updates after lifecycle-only events", () => {
    let state = applyRuntimeEvent(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      { type: EventType.RUN_STARTED, runId: "run-1" },
    );

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([
        userMessage("hi"),
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "fresh snapshot" }],
        },
      ]),
    });

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.lifecycle).toMatchObject({
      threadStatus: "working",
      runStarted: true,
    });
    expect(viewModel.dbMessages).toHaveLength(2);
    expect(viewModel.dbMessages[1]).toMatchObject({
      type: "agent",
      parts: [{ type: "text", text: "fresh snapshot" }],
    });
  });

  it("preserves optimistic queued and side-panel state across hydration until durable reconciliation", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("optimistic"),
        optimisticStatus: "booting",
        clientSubmissionId: "sub-existing-3",
      },
    );
    state = threadViewModelReducer(state, {
      type: "optimistic.queued-messages-updated",
      messages: [userMessage("queued")],
    });

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([userMessage("hi")]),
    });
    let viewModel = projectThreadViewModel(state);
    expect(viewModel.queuedMessages).toEqual([userMessage("queued")]);
    expect(viewModel.sidePanel.messages).toHaveLength(2);
    expect(viewModel.sidePanel.messages.at(-1)).toMatchObject({
      type: "user",
      parts: [{ type: "text", text: "optimistic" }],
    });

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWithMessages([userMessage("hi")]),
    });
    viewModel = projectThreadViewModel(state);
    expect(viewModel.queuedMessages).toBeNull();
    expect(viewModel.sidePanel.messages).toHaveLength(1);
  });

  it("ignores overlapping replay/live transcript events in the sidecar reducer", () => {
    const initialState = createInitialThreadViewModelState(
      snapshotWithMessages([]),
    );
    const state = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        eventId: "e-start",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        eventId: "e-start",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        deltaSeq: 1,
        delta: "hel",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        deltaSeq: 1,
        delta: "hel",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        deltaSeq: 2,
        delta: "lo",
      },
    ].reduce(
      (current, event) => applyAgUiEvent(current, event as BaseEvent),
      initialState,
    );

    expect(state).toBe(initialState);
  });

  it("quarantines malformed rich projection parts", () => {
    const state = applyAgUiEvent(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: EventType.CUSTOM,
        name: "terragon.data-part",
        value: {
          messageId: "m1",
          name: "terragon.image",
          data: { type: "image", image_url: 42 },
        },
      },
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.quarantine).toEqual([
      {
        reason: "malformed-rich-part",
        eventType: EventType.CUSTOM,
        messageId: "m1",
        partType: "image",
      },
    ]);
  });

  it("quarantines malformed renderable rich projection parts", () => {
    const state = applyAgUiEvent(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: EventType.CUSTOM,
        name: "terragon.data-part",
        value: {
          messageId: "m1",
          name: "terragon.terminal",
          data: { type: "terminal", sandboxId: 42, chunks: [] },
        },
      },
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.quarantine).toEqual([
      {
        reason: "malformed-rich-part",
        eventType: EventType.CUSTOM,
        messageId: "m1",
        partType: "terminal",
      },
    ]);
  });

  it("quarantines STATE_DELTA add ops missing a value field", () => {
    const state = applyAgUiEvent(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/sandbox" }],
      } as BaseEvent,
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.quarantine).toEqual([
      {
        reason: "malformed-native-runtime-event",
        eventType: EventType.STATE_DELTA,
      },
    ]);
  });

  it("accepts STATE_DELTA add ops with a falsy value field", () => {
    const state = applyAgUiEvent(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/sandbox", value: false }],
      } as BaseEvent,
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.quarantine).toEqual([]);
  });

  it("accepts live structured plan parts without sidecar transcript projection", () => {
    const state = applyAgUiEvent(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: EventType.CUSTOM,
        name: "terragon.data-part",
        value: {
          messageId: "m1",
          partIndex: 0,
          name: "terragon.plan",
          data: {
            type: "plan",
            entries: [
              {
                content: "Wire the reducer",
                priority: "high",
                status: "pending",
              },
            ],
          },
        },
      },
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.quarantine).toEqual([]);
  });

  it("ignores native side-effect user snapshots instead of quarantining them", () => {
    const state = applyAgUiEvent(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          {
            id: "side-effect-user-0-abc123abc123",
            role: "user",
            content: "Continue",
          },
        ],
      } as BaseEvent,
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.quarantine).toEqual([]);
    expect(viewModel.lifecycleMessages).toEqual([]);
  });

  it("projects lifecycle system notices into lifecycleMessages", () => {
    const state = createInitialThreadViewModelState(
      snapshotWithMessages([
        userMessage("hi"),
        {
          type: "system",
          message_type: "generic-retry",
          parts: [{ type: "text", text: "Retrying..." }],
        },
      ]),
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.dbMessages).toHaveLength(2);
    expect(viewModel.lifecycleMessages).toEqual([
      expect.objectContaining({
        role: "system",
        message_type: "generic-retry",
      }),
    ]);
  });

  it("keeps live snapshot lifecycle notices in sidecar-only projection", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = applyAgUiEvent(state, {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        {
          id: "side-effect-system:invalid-token-retry-0-abc123abc123",
          role: "system",
          content: "Retrying with refreshed token",
        },
        {
          id: "side-effect-user-0-abc123abc123",
          role: "user",
          content: "Continue",
        },
      ],
    } as BaseEvent);
    const viewModel = projectThreadViewModel(state);
    expect(viewModel.lifecycleMessages).toEqual([
      expect.objectContaining({
        id: "side-effect-system:invalid-token-retry-0-abc123abc123",
        role: "system",
        message_type: "invalid-token-retry",
      }),
    ]);
  });

  it("keeps lifecycle notice references stable across ordinary text tokens", () => {
    let state = createInitialThreadViewModelState(
      snapshotWithMessages([
        {
          type: "system",
          message_type: "generic-retry",
          parts: [{ type: "text", text: "Retrying..." }],
        },
      ]),
    );
    const lifecycleMessages = state.lifecycleMessages;

    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "live-agent-1",
    });
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "live-agent-1",
      delta: "streamed token",
    });

    expect(state.lifecycleMessages).toBe(lifecycleMessages);
    expect(projectThreadViewModel(state).lifecycleMessages).toBe(
      lifecycleMessages,
    );
  });

  it("reconciles durable DB messages after ignored live transcript events", () => {
    let state = applyAgUiEvent(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "live-1",
      },
    );
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "live-1",
      delta: "live",
    });

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWithMessages([
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "durable" }],
        },
      ]),
    });
    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
      snapshot: snapshotWithMessages([
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "later snapshot" }],
        },
      ]),
    });

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.dbMessages[0]).toMatchObject({
      type: "agent",
      parts: [{ type: "text", text: "later snapshot" }],
    });
  });

  it("projects meta chips, GitHub summary, side-panel inputs, and artifacts from the view model", () => {
    const dbMessages: DBMessage[] = [
      userMessage("hi"),
      {
        type: "agent",
        parent_tool_use_id: null,
        parts: [
          {
            type: "text",
            text: "<proposed_plan>\nShip the reducer surface.\n</proposed_plan>",
          },
        ],
      },
    ];
    let state = createInitialThreadViewModelState(
      snapshotWithMessages(dbMessages, {
        githubSummary: {
          prStatus: "open",
          prChecksStatus: "pending",
          githubPRNumber: 42,
          githubRepoFullName: "terragon/oss",
        },
        artifactThread: {
          ...artifactThread(),
          gitDiff: "diff --git a/a.ts b/a.ts\n",
        },
      }),
    );

    state = applyAgUiEvent(state, {
      type: EventType.CUSTOM,
      name: "thread.token_usage_updated",
      value: {
        kind: "thread.token_usage_updated",
        usage: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 4,
        },
      },
    });

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.githubSummary).toMatchObject({
      prStatus: "open",
      prChecksStatus: "pending",
      githubPRNumber: 42,
      githubRepoFullName: "terragon/oss",
    });
    expect(viewModel.meta.tokenUsage).toEqual({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 4,
    });
    expect(viewModel.sidePanel).toMatchObject({
      messages: dbMessages,
      threadChatId: "chat-1",
    });
    expect(
      viewModel.artifacts.descriptors.map((artifact) => artifact.kind),
    ).toEqual(["git-diff", "plan"]);
  });

  it("updates lifecycle from runtime events", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));

    state = applyRuntimeEvent(state, {
      type: EventType.RUN_STARTED,
      runId: "run-1",
    });
    expect(projectThreadViewModel(state).lifecycle).toMatchObject({
      runId: "run-1",
      runStarted: true,
      threadStatus: "working",
    });

    state = applyRuntimeEvent(state, { type: EventType.RUN_FINISHED });
    expect(projectThreadViewModel(state).lifecycle).toMatchObject({
      runStarted: false,
      threadStatus: "complete",
    });

    state = applyRuntimeEvent(state, { type: EventType.RUN_ERROR });
    expect(projectThreadViewModel(state).lifecycle).toMatchObject({
      runStarted: false,
      threadStatus: "error",
    });
  });

  describe("reported status_changed -> runStarted (characterization)", () => {
    const ALL_THREAD_STATUSES = [
      "queued-blocked",
      "error",
      "stopped",
      "working-stopped",
      "draft",
      "scheduled",
      "queued",
      "queued-tasks-concurrency",
      "queued-sandbox-creation-rate-limit",
      "queued-agent-rate-limit",
      "booting",
      "working",
      "stopping",
      "working-error",
      "working-done",
      "checkpointing",
      "complete",
    ] as const;

    const expectedReportedRunStarted = (status: string) =>
      status === "working" || status === "booting";

    for (const status of ALL_THREAD_STATUSES) {
      it(`status_changed(${status}) -> runStarted=${expectedReportedRunStarted(status)}`, () => {
        const state = threadViewModelReducer(
          createInitialThreadViewModelState(snapshotWithMessages([])),
          {
            type: "ag-ui.event",
            event: {
              type: EventType.CUSTOM,
              name: "thread.status_changed",
              value: { status },
            } as BaseEvent,
          },
        );
        const lifecycle = projectThreadViewModel(state).lifecycle;
        expect(lifecycle.threadStatus).toBe(status);
        expect(lifecycle.runStarted).toBe(expectedReportedRunStarted(status));
      });
    }
  });

  it("projects optimistic permission updates through the view model", () => {
    const state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: "optimistic.permission-mode-updated",
        permissionMode: "allowAll",
      },
    );

    expect(projectThreadViewModel(state).permissionMode).toBe("allowAll");
  });

  it("does not synthesize artifacts from ordinary token streaming", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    const initialArtifacts = state.artifacts;
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "plan-msg",
    });
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "plan-msg",
      delta: "<proposed_plan>\nDo the work.\n</proposed_plan>",
    });
    expect(state.artifacts).toBe(initialArtifacts);

    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "plan-msg",
      delta: "\nNow implementing.",
    });

    expect(projectThreadViewModel(state).artifacts.descriptors).toEqual([]);
    expect(state.artifacts).toBe(initialArtifacts);
  });

  it("leaves streamed proposed_plan text to assistant-ui transcript ownership", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    const initialArtifacts = state.artifacts;
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "plan-msg",
    });
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "plan-msg",
      delta: "<proposed_plan>\nDo the work.\n</proposed",
    });

    expect(state.artifacts).toBe(initialArtifacts);

    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "plan-msg",
      delta: "_plan>",
    });

    expect(projectThreadViewModel(state).artifacts.descriptors).toEqual([]);
    expect(state.artifacts).toBe(initialArtifacts);
  });

  it("updates artifact descriptors when artifact content changes under a stable id", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = applyAgUiEvent(state, {
      type: EventType.CUSTOM,
      name: "artifact-reference",
      value: {
        artifactId: "artifact-plan-1",
        artifactType: "plan",
        title: "Runtime Plan",
        uri: "r2://plans/first.md",
        status: "ready",
      },
    });
    const firstArtifacts = state.artifacts;

    state = applyAgUiEvent(state, {
      type: EventType.CUSTOM,
      name: "artifact-reference",
      value: {
        artifactId: "artifact-plan-1",
        artifactType: "plan",
        title: "Runtime Plan",
        uri: "r2://plans/second.md",
        status: "ready",
      },
    });

    expect(state.artifacts).not.toBe(firstArtifacts);
    expect(
      projectThreadViewModel(state).artifacts.descriptors[0],
    ).toMatchObject({
      id: "artifact:reference:artifact-plan-1",
      summary: "r2://plans/second.md",
      part: {
        planText: "Runtime Plan\n\nr2://plans/second.md",
      },
    });
  });

  it("preserves replayed artifact references across server refetch reconciliation", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = applyAgUiEvent(state, {
      type: EventType.CUSTOM,
      name: "artifact-reference",
      value: {
        artifactId: "artifact-plan-1",
        artifactType: "plan",
        title: "Runtime Plan",
        uri: "r2://plans/runtime-plan.md",
        status: "ready",
      },
    });

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWithMessages([
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "durable text" }],
        },
      ]),
    });

    expect(projectThreadViewModel(state).artifacts.descriptors).toEqual([
      expect.objectContaining({
        id: "artifact:reference:artifact-plan-1",
        kind: "plan",
        title: "Runtime Plan",
      }),
    ]);
  });

  it("keeps persisted replay events out of sidecar transcript before refetch reconciliation", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    const replayedEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg-replay",
        eventId: "event-start",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-replay",
        deltaSeq: 1,
        delta: "hello",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-replay",
        deltaSeq: 2,
        delta: " world",
      } as BaseEvent,
    ];

    for (const replayedEvent of [...replayedEvents, ...replayedEvents]) {
      state = applyAgUiEvent(state, replayedEvent);
    }

    state = threadViewModelReducer(state, {
      type: "server.refetch-reconciled",
      snapshot: snapshotWithMessages([
        {
          type: "agent",
          parent_tool_use_id: null,
          parts: [{ type: "text", text: "hello world" }],
        },
      ]),
    });

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.dbMessages).toHaveLength(1);
    expect(viewModel.dbMessages[0]).toMatchObject({
      type: "agent",
      parts: [{ type: "text", text: "hello world" }],
    });
  });

  it("keeps transcript state stable when product sidecars receive transcript events", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    const initialState = state;
    const projector = createThreadViewSidecarEventProjector();
    const transcriptEvents: BaseEvent[] = [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "agent-1",
        delta: "token",
      } as BaseEvent,
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "agent-1:reasoning",
        delta: "thought",
      } as BaseEvent,
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "tool-1",
        toolCallName: "Bash",
      } as BaseEvent,
    ];

    for (const event of transcriptEvents) {
      const projected = projector(event);
      if (projected) {
        state = threadViewModelReducer(state, {
          type: "ag-ui.event",
          event: projected,
        });
      }
    }

    expect(state).toBe(initialState);
  });

  it("keeps transcript state stable when product sidecars receive lifecycle, meta, and runtime events", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "agent-1",
    } as BaseEvent);
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "agent-1",
      delta: "partial text",
    } as BaseEvent);
    state = applyAgUiEvent(state, {
      type: EventType.REASONING_MESSAGE_START,
      messageId: "agent-1:thinking:0",
    } as BaseEvent);
    state = applyAgUiEvent(state, {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "agent-1:thinking:0",
      delta: "partial thought",
    } as BaseEvent);
    state = applyAgUiEvent(state, {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "Bash",
    } as BaseEvent);
    state = applyAgUiEvent(state, {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: '{"command":"pwd"}',
    } as BaseEvent);

    const productSidecars: ThreadViewEvent[] = [
      {
        type: "runtime.event",
        event: { type: EventType.RUN_STARTED, runId: "run-1" } as BaseEvent,
      },
      {
        type: "runtime.event",
        event: { type: EventType.RUN_FINISHED, runId: "run-1" } as BaseEvent,
      },
      {
        type: "runtime.event",
        event: {
          type: EventType.RUN_ERROR,
          runId: "run-1",
          message: "failed",
        } as BaseEvent,
      },
      {
        type: "ag-ui.event",
        event: {
          type: EventType.STATE_SNAPSHOT,
          snapshot: { sandbox: "ready" },
        } as BaseEvent,
      },
      {
        type: "ag-ui.event",
        event: {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: "activity-1",
          activityType: "status",
          content: { text: "running" },
        } as BaseEvent,
      },
      {
        type: "ag-ui.event",
        event: {
          type: EventType.CUSTOM,
          name: "thread.status_changed",
          value: { status: "working" },
        } as BaseEvent,
      },
      {
        type: "ag-ui.event",
        event: {
          type: EventType.CUSTOM,
          name: "artifact-reference",
          value: {
            artifactId: "plan-1",
            artifactType: "plan",
            title: "Plan",
            status: "ready",
          },
        } as BaseEvent,
      },
      {
        type: "ag-ui.event",
        event: {
          type: EventType.CUSTOM,
          name: "thread.token_usage_updated",
          value: {
            kind: "thread.token_usage_updated",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 2,
            },
          },
        } as BaseEvent,
      },
    ];

    for (const event of productSidecars) {
      state = threadViewModelReducer(state, event);
    }
    expect(state.lifecycle.runId).toBe("run-1");
    expect(state.artifacts.descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "artifact:reference:plan-1",
          title: "Plan",
        }),
      ]),
    );
  });
});

function applyAgUiEvent(
  state: ThreadViewModelState,
  event: BaseEvent,
): ThreadViewModelState {
  return threadViewModelReducer(state, {
    type: "ag-ui.event",
    event,
  });
}

function applyRuntimeEvent(
  state: ThreadViewModelState,
  event: BaseEvent,
): ThreadViewModelState {
  return threadViewModelReducer(state, {
    type: "runtime.event",
    event,
  });
}

function snapshotWithMessages(
  dbMessages: DBMessage[],
  overrides: Partial<
    Pick<
      ThreadViewSnapshot,
      "artifactThread" | "githubSummary" | "permissionMode"
    >
  > & { status?: ThreadStatus } = {},
): ThreadViewSnapshot {
  return createThreadViewSnapshot({
    threadChat: threadPageChat({
      messages: dbMessages,
      permissionMode: overrides.permissionMode,
      status: overrides.status,
    }),
    agent: "claudeCode",
    source: "collection",
    artifactThread: overrides.artifactThread ?? artifactThread(),
    githubSummary: overrides.githubSummary ?? githubSummary(),
  });
}

function artifactThread(): ThreadViewSnapshot["artifactThread"] {
  return {
    id: "thread-1",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    gitDiff: null,
    gitDiffStats: null,
  };
}

function githubSummary(): ThreadViewSnapshot["githubSummary"] {
  return {
    prStatus: null,
    prChecksStatus: null,
    githubPRNumber: null,
    githubRepoFullName: "",
  };
}

function userMessage(text: string): DBUserMessage {
  return {
    type: "user",
    model: null,
    parts: [{ type: "text", text }],
  };
}

function threadPageChat({
  messages,
  projectedMessages = messages,
  isCanonicalProjection = false,
  permissionMode = "allowAll",
  status = "complete",
}: {
  messages: DBMessage[];
  projectedMessages?: DBMessage[];
  isCanonicalProjection?: boolean;
  permissionMode?: ThreadPageChat["permissionMode"];
  status?: ThreadStatus;
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
    status,
    projectedMessages,
    isCanonicalProjection,
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
