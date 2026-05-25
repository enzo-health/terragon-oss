import { EventType, type BaseEvent } from "@ag-ui/core";
import type { DBMessage, DBUserMessage } from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dbMessagesToAgUiMessages } from "../db-messages-to-ag-ui";
import { toUIMessages } from "../toUIMessages";
import { createThreadViewSidecarEventProjector } from "../use-ag-ui-messages";
import {
  createThreadViewSnapshot,
  selectThreadViewDbMessages,
} from "./snapshot-adapter";
import {
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "./reducer";
import type { ThreadViewModelState, ThreadViewSnapshot } from "./types";

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

  it("keeps native AG UI replay as the active transcript source", () => {
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

    expect(projectThreadViewModel(state).messages).toEqual([
      expect.objectContaining({
        id: "native-msg-1",
        role: "agent",
        parts: [{ type: "text", text: "rendered from replay" }],
      }),
    ]);
  });

  it("hydrates DB snapshot and suppresses duplicate replay assistant bubbles", () => {
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
    expect(viewModel.messages).toHaveLength(2);
    expect(viewModel.messages.map((message) => message.role)).toEqual([
      "user",
      "agent",
    ]);
    expect(viewModel.messages[1]?.id).toBe("msg_abc123");
  });

  it("makes optimistic user submit visible on the same projection surface", () => {
    const state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "optimistic.user-submitted",
        message: userMessage("next"),
        optimisticStatus: "booting",
      },
    );

    const viewModel = projectThreadViewModel(state);
    expect(viewModel.threadStatus).toBe("booting");
    expect(viewModel.messages).toHaveLength(2);
    expect(viewModel.messages[1]).toMatchObject({
      id: "user-optimistic-chat-1-1",
      role: "user",
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
    expect(viewModel.messages).toHaveLength(1);
    expect(viewModel.messages[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
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

  it("allows snapshot transcript updates after lifecycle-only events", () => {
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
    expect(viewModel.messages).toHaveLength(2);
    expect(viewModel.messages[1]).toMatchObject({
      role: "agent",
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

  it("dedupes overlapping replay/live events without dropping streamed content", () => {
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
      createInitialThreadViewModelState(snapshotWithMessages([])),
    );

    expect(projectThreadViewModel(state).messages[0]).toMatchObject({
      role: "agent",
      parts: [{ type: "text", text: "hello" }],
    });
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
    expect(viewModel.messages).toEqual([]);
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
    expect(viewModel.messages).toEqual([]);
    expect(viewModel.quarantine).toEqual([
      {
        reason: "malformed-rich-part",
        eventType: EventType.CUSTOM,
        messageId: "m1",
        partType: "terminal",
      },
    ]);
  });

  it("accepts live structured plan rich projection parts", () => {
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
    expect(viewModel.messages[0]).toMatchObject({
      role: "agent",
      parts: [
        {
          type: "plan-structured",
          entries: [
            {
              content: "Wire the reducer",
              priority: "high",
              status: "pending",
            },
          ],
        },
      ],
    });
  });

  it("projects native side-effect message snapshots instead of quarantining them", () => {
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
    expect(viewModel.messages).toEqual([
      {
        id: "side-effect-user-0-abc123abc123",
        role: "user",
        parts: [{ type: "text", text: "Continue" }],
        model: null,
      },
    ]);
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
    expect(viewModel.messages).toEqual([
      expect.objectContaining({
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      }),
    ]);
    expect(viewModel.lifecycleMessages).toEqual([
      expect.objectContaining({
        role: "system",
        message_type: "generic-retry",
      }),
    ]);
  });

  it("clears live transcript precedence after durable reconciliation", () => {
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

    expect(projectThreadViewModel(state).messages[0]).toMatchObject({
      role: "agent",
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

  it("keeps artifact descriptor references stable during unrelated token streaming", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "plan-msg",
    });
    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "plan-msg",
      delta: "<proposed_plan>\nDo the work.\n</proposed_plan>",
    });
    const artifactsAfterPlan = state.artifacts;

    state = applyAgUiEvent(state, {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "plan-msg",
      delta: "\nNow implementing.",
    });

    expect(projectThreadViewModel(state).artifacts.descriptors).toHaveLength(1);
    expect(state.artifacts).toBe(artifactsAfterPlan);
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

  it("upserts a repo-file descriptor when a repo file is opened", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "src/foo.ts",
      lineRange: { start: 10, end: 20 },
    });

    const descriptors = projectThreadViewModel(state).artifacts.descriptors;
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({
      id: "artifact:repo-file:working:src/foo.ts",
      kind: "repo-file",
      title: "foo.ts",
      summary: "src/foo.ts",
      origin: {
        type: "repo-file",
        path: "src/foo.ts",
        lineRange: { start: 10, end: 20 },
      },
    });
  });

  it("reuses the existing repo-file descriptor when the same file is opened again", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "src/foo.ts",
    });
    const firstArtifacts = state.artifacts;

    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "src/foo.ts",
    });

    expect(state.artifacts).toBe(firstArtifacts);
    expect(projectThreadViewModel(state).artifacts.descriptors).toHaveLength(1);
  });

  it("treats the same path under a different ref as a distinct repo-file descriptor", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "src/foo.ts",
    });
    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "src/foo.ts",
      ref: "abc123",
    });

    const ids = projectThreadViewModel(state)
      .artifacts.descriptors.map((descriptor) => descriptor.id)
      .sort();
    expect(ids).toEqual([
      "artifact:repo-file:abc123:src/foo.ts",
      "artifact:repo-file:working:src/foo.ts",
    ]);
  });

  it("preserves click-opened repo-file descriptors across snapshot hydration", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = threadViewModelReducer(state, {
      type: "repo-file.opened",
      path: "docs/readme.md",
    });

    state = threadViewModelReducer(state, {
      type: "snapshot.hydrated",
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
        id: "artifact:repo-file:working:docs/readme.md",
        kind: "repo-file",
        title: "readme.md",
      }),
    ]);
  });

  it("dedupes persisted replay events across reconnect before refetch reconciliation", () => {
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

    expect(projectThreadViewModel(state).messages[0]).toMatchObject({
      role: "agent",
      parts: [{ type: "text", text: "hello world" }],
    });

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

    expect(projectThreadViewModel(state).messages).toHaveLength(1);
    expect(projectThreadViewModel(state).messages[0]).toMatchObject({
      role: "agent",
      parts: [{ type: "text", text: "hello world" }],
    });
  });

  it("keeps transcript state stable when product sidecars receive transcript events", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    const initialTranscript = state.transcript;
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

    expect(state.transcript).toBe(initialTranscript);
    expect(projectThreadViewModel(state).messages).toEqual([]);
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
  > = {},
): ThreadViewSnapshot {
  return createThreadViewSnapshot({
    threadChat: threadPageChat({
      messages: dbMessages,
      permissionMode: overrides.permissionMode,
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
}: {
  messages: DBMessage[];
  projectedMessages?: DBMessage[];
  isCanonicalProjection?: boolean;
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
