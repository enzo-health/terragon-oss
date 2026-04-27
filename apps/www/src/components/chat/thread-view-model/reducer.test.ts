import { EventType, type BaseEvent } from "@ag-ui/core";
import type { DBMessage, DBUserMessage } from "@terragon/shared";
import type { ThreadPageChat } from "@terragon/shared/db/types";
import { describe, expect, it } from "vitest";
import { dbMessagesToAgUiMessages } from "../db-messages-to-ag-ui";
import { toUIMessages } from "../toUIMessages";
import {
  createThreadViewSnapshot,
  selectThreadViewDbMessages,
} from "./legacy-db-message-adapter";
import {
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "./reducer";
import type { ThreadViewSnapshot } from "./types";

describe("ThreadViewModel reducer", () => {
  it("keeps the legacy DB snapshot adapter at toUIMessages/dbMessagesToAgUi parity", () => {
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

  it("keeps legacy user turns when canonical projection is assistant-only", () => {
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
      legacyUser,
      projectedAgent,
    ]);
  });

  it("keeps missing legacy user turns in transcript order with canonical projections", () => {
    const legacyUser1 = userMessage("first");
    const legacyUser2 = userMessage("second");
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
      projectedMessages: [projectedAgent1, projectedAgent2],
      isCanonicalProjection: true,
    });

    expect(selectThreadViewDbMessages(chat).dbMessages).toEqual([
      legacyUser1,
      projectedAgent1,
      legacyUser2,
      projectedAgent2,
    ]);
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

    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "msg_abc123",
      } as BaseEvent,
    });
    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg_abc123",
        delta: "hello",
      } as BaseEvent,
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
      role: "user",
      parts: [{ type: "text", text: "next" }],
    });
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
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "runtime.event",
        event: { type: EventType.RUN_STARTED, runId: "run-1" } as BaseEvent,
      },
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
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(
        snapshotWithMessages([userMessage("hi")]),
      ),
      {
        type: "runtime.event",
        event: { type: EventType.RUN_STARTED, runId: "run-1" } as BaseEvent,
      },
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
      (current, event) =>
        threadViewModelReducer(current, {
          type: "ag-ui.event",
          event: event as BaseEvent,
        }),
      createInitialThreadViewModelState(snapshotWithMessages([])),
    );

    expect(projectThreadViewModel(state).messages[0]).toMatchObject({
      role: "agent",
      parts: [{ type: "text", text: "hello" }],
    });
  });

  it("quarantines malformed rich projection parts", () => {
    const state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: "ag-ui.event",
        event: {
          type: EventType.CUSTOM,
          name: "terragon.part.image",
          value: {
            messageId: "m1",
            part: { type: "image", image_url: 42 },
          },
        } as BaseEvent,
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
    const state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: "ag-ui.event",
        event: {
          type: EventType.CUSTOM,
          name: "terragon.part.terminal",
          value: {
            messageId: "m1",
            part: { type: "terminal", sandboxId: 42, chunks: [] },
          },
        } as BaseEvent,
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
    const state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: "ag-ui.event",
        event: {
          type: EventType.CUSTOM,
          name: "terragon.part.plan",
          value: {
            messageId: "m1",
            part: {
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
        } as BaseEvent,
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

  it("clears live transcript precedence after durable reconciliation", () => {
    let state = threadViewModelReducer(
      createInitialThreadViewModelState(snapshotWithMessages([])),
      {
        type: "ag-ui.event",
        event: {
          type: EventType.TEXT_MESSAGE_START,
          messageId: "live-1",
        } as BaseEvent,
      },
    );
    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "live-1",
        delta: "live",
      } as BaseEvent,
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

    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
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
      } as BaseEvent,
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

    state = threadViewModelReducer(state, {
      type: "runtime.event",
      event: { type: EventType.RUN_STARTED, runId: "run-1" } as BaseEvent,
    });
    expect(projectThreadViewModel(state).lifecycle).toMatchObject({
      runId: "run-1",
      runStarted: true,
      threadStatus: "working",
    });

    state = threadViewModelReducer(state, {
      type: "runtime.event",
      event: { type: EventType.RUN_FINISHED } as BaseEvent,
    });
    expect(projectThreadViewModel(state).lifecycle).toMatchObject({
      runStarted: false,
      threadStatus: "complete",
    });

    state = threadViewModelReducer(state, {
      type: "runtime.event",
      event: { type: EventType.RUN_ERROR } as BaseEvent,
    });
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
    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "plan-msg",
      } as BaseEvent,
    });
    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "plan-msg",
        delta: "<proposed_plan>\nDo the work.\n</proposed_plan>",
      } as BaseEvent,
    });
    const artifactsAfterPlan = state.artifacts;

    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "plan-msg",
        delta: "\nNow implementing.",
      } as BaseEvent,
    });

    expect(projectThreadViewModel(state).artifacts.descriptors).toHaveLength(1);
    expect(state.artifacts).toBe(artifactsAfterPlan);
  });

  it("preserves replayed artifact references across server refetch reconciliation", () => {
    let state = createInitialThreadViewModelState(snapshotWithMessages([]));
    state = threadViewModelReducer(state, {
      type: "ag-ui.event",
      event: {
        type: EventType.CUSTOM,
        name: "artifact-reference",
        value: {
          artifactId: "artifact-plan-1",
          artifactType: "plan",
          title: "Runtime Plan",
          uri: "r2://plans/runtime-plan.md",
          status: "ready",
        },
      } as BaseEvent,
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
      state = threadViewModelReducer(state, {
        type: "ag-ui.event",
        event: replayedEvent,
      });
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
});

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
    messages,
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
