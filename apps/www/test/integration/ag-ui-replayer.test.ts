/* @vitest-environment jsdom */

/**
 * AG-UI replayer integration test — Phase 7.
 *
 * Feeds a representative AG-UI BaseEvent sequence through the live
 * ThreadViewModel sidecar (via `useThreadViewModel` / `useAgUiSidecarRouter`)
 * and asserts the lifecycle, artifact, and quarantine projection that the
 * production chat page consumes.
 *
 * Transcript message projection (text/tool/rich parts) is rendered by the
 * `chat/transcript-view/` store fold + leaf registry in production and is
 * covered by `transcript-view/registry.test.tsx` and the store tests; this
 * harness intentionally does not re-assert it.
 */

import { describe, expect, it } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { replayAgUi, textContent, textStart } from "./ag-ui-replayer";

describe("AG-UI replayer integration", () => {
  it("keeps well-formed native runtime events out of quarantine", async () => {
    const { quarantine } = await replayAgUi([
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { plan: { status: "running" }, bootStep: "install" },
      } as BaseEvent,
      {
        type: EventType.STATE_DELTA,
        delta: [
          { op: "replace", path: "/plan/status", value: "complete" },
          { op: "add", path: "/currentTool", value: "pnpm test" },
        ],
      } as BaseEvent,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "msg-activity",
        activityType: "boot",
        content: { text: "Installing dependencies", status: "running" },
      } as BaseEvent,
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: "msg-activity",
        activityType: "boot",
        patch: [
          { op: "replace", path: "/status", value: "complete" },
          { op: "add", path: "/exitCode", value: 0 },
        ],
      } as BaseEvent,
    ]);

    expect(quarantine).toEqual([]);
  });

  it("keeps unsupported native families quarantined explicitly", async () => {
    const { quarantine } = await replayAgUi([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [],
      } as BaseEvent,
      {
        type: EventType.RAW,
        event: { type: "provider.internal" },
      } as BaseEvent,
    ]);

    expect(quarantine).toEqual([
      {
        reason: "unsupported-ag-ui-event",
        eventType: EventType.RAW,
      },
    ]);
  });

  it("quarantines malformed native runtime events", async () => {
    const { quarantine } = await replayAgUi([
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: null,
      } as BaseEvent,
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: "msg-activity",
        activityType: "boot",
        patch: [{ path: "/status", value: "nope" }],
      } as BaseEvent,
    ]);

    expect(quarantine).toEqual([
      {
        reason: "malformed-native-runtime-event",
        eventType: EventType.STATE_SNAPSHOT,
      },
      {
        reason: "malformed-native-runtime-event",
        eventType: EventType.ACTIVITY_DELTA,
      },
    ]);
  });

  it("quarantines state/activity patches that target prototype fields", async () => {
    const { quarantine } = await replayAgUi([
      {
        type: EventType.STATE_SNAPSHOT,
        snapshot: { plan: { status: "running" } },
      } as BaseEvent,
      {
        type: EventType.STATE_DELTA,
        delta: [{ op: "add", path: "/__proto__/polluted", value: true }],
      } as BaseEvent,
      {
        type: EventType.ACTIVITY_SNAPSHOT,
        messageId: "msg-activity",
        activityType: "boot",
        content: { status: "running" },
      } as BaseEvent,
      {
        type: EventType.ACTIVITY_DELTA,
        messageId: "msg-activity",
        activityType: "boot",
        patch: [{ op: "add", path: "/constructor/polluted", value: true }],
      } as BaseEvent,
    ]);

    expect(quarantine).toEqual([
      {
        reason: "malformed-native-runtime-event",
        eventType: EventType.STATE_DELTA,
      },
      {
        reason: "malformed-native-runtime-event",
        eventType: EventType.ACTIVITY_DELTA,
      },
    ]);
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });

  it("reconstructs lifecycle from canonical run events without refetch state", async () => {
    const { lifecycle, quarantine } = await replayAgUi([
      {
        type: EventType.RUN_STARTED,
        runId: "run-1",
      } as BaseEvent,
      textStart("msg-run"),
      textContent("msg-run", "Working"),
      {
        type: EventType.RUN_FINISHED,
        runId: "run-1",
      } as BaseEvent,
    ]);

    expect(quarantine).toEqual([]);
    expect(lifecycle).toMatchObject({
      runId: "run-1",
      runStarted: false,
      threadStatus: "complete",
    });
  });

  it("replays canonical plan artifact references into artifact descriptors", async () => {
    const { artifactDescriptors } = await replayAgUi([
      {
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
    ]);

    expect(artifactDescriptors).toEqual([
      expect.objectContaining({
        id: "artifact:reference:artifact-plan-1",
        kind: "plan",
        title: "Runtime Plan",
        part: expect.objectContaining({
          type: "plan",
          planText: "Runtime Plan\n\nr2://plans/runtime-plan.md",
        }),
        origin: expect.objectContaining({
          type: "artifact-reference",
          artifactId: "artifact-plan-1",
          artifactType: "plan",
          uri: "r2://plans/runtime-plan.md",
        }),
      }),
    ]);
  });
});
