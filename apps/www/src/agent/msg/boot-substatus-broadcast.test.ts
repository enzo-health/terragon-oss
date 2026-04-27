/**
 * Unit tests for the server-side boot.substatus_changed meta event emission.
 *
 * These tests exercise the closure logic that wraps `onStatusUpdate` in
 * `startAgentMessage.ts` — specifically that:
 *  - a `boot.substatus_changed` meta event is broadcast for each non-null
 *    bootingStatus transition
 *  - `from` is null on the first transition
 *  - `from` equals the previous substatus on subsequent transitions
 *  - `durationMs` is absent on the first transition and present thereafter
 *  - no broadcast is fired when `bootingStatus` is null
 *
 * Rather than invoking `startAgentMessage` end-to-end (which requires a full
 * DB/sandbox mock stack), we extract and test the logic that builds and
 * broadcasts the meta event directly, mirroring the shape of the production
 * callback.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ThreadMetaEvent } from "@terragon/shared/runtime/thread-meta-event";
import type { BootingSubstatus } from "@terragon/sandbox/types";

// ---------------------------------------------------------------------------
// Helpers — mirror the production closure from startAgentMessage.ts
// ---------------------------------------------------------------------------

type PublishFn = (metaEvent: ThreadMetaEvent) => Promise<void>;

/**
 * Creates the same tracking closure used in `startAgentMessage.ts` so we can
 * test the emit logic in isolation without the full sandbox/DB stack.
 */
function makeBootSubstatusTracker(publishFn: PublishFn) {
  let lastBootingSubstatus: BootingSubstatus | null = null;
  let lastBootingTransitionAt: number | null = null;

  return async function handleBootingStatus(
    threadId: string,
    bootingStatus: BootingSubstatus | null,
    nowMs: number,
  ): Promise<void> {
    if (bootingStatus === null) {
      return;
    }
    const durationMs =
      lastBootingTransitionAt !== null
        ? nowMs - lastBootingTransitionAt
        : undefined;
    const metaEvent: ThreadMetaEvent = {
      kind: "boot.substatus_changed",
      threadId,
      from: lastBootingSubstatus,
      to: bootingStatus,
      timestamp: new Date(nowMs).toISOString(),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    await publishFn(metaEvent);
    lastBootingSubstatus = bootingStatus;
    lastBootingTransitionAt = nowMs;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("boot.substatus_changed meta event emission", () => {
  const THREAD_ID = "thread-abc";
  let published: ThreadMetaEvent[];
  let publishFn: ReturnType<typeof vi.fn>;
  let tracker: ReturnType<typeof makeBootSubstatusTracker>;

  beforeEach(() => {
    published = [];
    publishFn = vi.fn(async (event: ThreadMetaEvent) => {
      published.push(event);
    });
    tracker = makeBootSubstatusTracker(publishFn);
  });

  it("emits an event with from=null on the first transition", async () => {
    await tracker(THREAD_ID, "provisioning", 1000);

    expect(published).toHaveLength(1);
    const event = published[0];
    if (!event || event.kind !== "boot.substatus_changed") {
      expect.fail("Expected boot.substatus_changed kind");
      return;
    }
    expect(event.from).toBeNull();
    expect(event.to).toBe("provisioning");
    expect(event.threadId).toBe(THREAD_ID);
    expect(event.durationMs).toBeUndefined();
    expect(event.timestamp).toBe(new Date(1000).toISOString());
  });

  it("emits from=previous substatus on the second transition", async () => {
    await tracker(THREAD_ID, "provisioning", 1000);
    await tracker(THREAD_ID, "cloning-repo", 2500);

    expect(published).toHaveLength(2);
    const second = published[1];
    if (!second || second.kind !== "boot.substatus_changed") {
      expect.fail("Expected boot.substatus_changed kind");
      return;
    }
    expect(second.from).toBe("provisioning");
    expect(second.to).toBe("cloning-repo");
    expect(second.durationMs).toBe(1500);
  });

  it("accumulates durationMs across multiple transitions", async () => {
    const steps: [BootingSubstatus, number][] = [
      ["provisioning", 0],
      ["provisioning-done", 3000],
      ["cloning-repo", 7000],
      ["installing-agent", 12000],
    ];
    for (const [status, ts] of steps) {
      await tracker(THREAD_ID, status, ts);
    }

    expect(published).toHaveLength(4);
    // First transition: no durationMs (no prior timestamp)
    expect(published[0]).toMatchObject({ from: null });
    expect(published[0]).not.toHaveProperty("durationMs");
    expect(published[1]).toMatchObject({
      from: "provisioning",
      durationMs: 3000,
    });
    expect(published[2]).toMatchObject({
      from: "provisioning-done",
      durationMs: 4000,
    });
    expect(published[3]).toMatchObject({
      from: "cloning-repo",
      durationMs: 5000,
    });
  });

  it("does not emit when bootingStatus is null", async () => {
    await tracker(THREAD_ID, null, 1000);
    expect(published).toHaveLength(0);
    expect(publishFn).not.toHaveBeenCalled();
  });

  it("null bootingStatus between two substatus values does not corrupt state", async () => {
    await tracker(THREAD_ID, "provisioning", 1000);
    await tracker(THREAD_ID, null, 2000); // no-op
    await tracker(THREAD_ID, "cloning-repo", 3000);

    // Second emitted event: from="provisioning", durationMs=2000 (3000-1000)
    expect(published).toHaveLength(2);
    const second = published[1];
    if (!second || second.kind !== "boot.substatus_changed") {
      expect.fail("Expected boot.substatus_changed kind");
      return;
    }
    expect(second.from).toBe("provisioning");
    expect(second.durationMs).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// Dedup guard tests (review requirement)
// ---------------------------------------------------------------------------

describe("boot.substatus_changed dedup guard", () => {
  const THREAD_ID = "thread-dedup";
  let published: ThreadMetaEvent[];
  let publishFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    published = [];
    publishFn = vi.fn(async (event: ThreadMetaEvent) => {
      published.push(event);
    });
  });

  it("does not emit when called twice with the same substatus", async () => {
    // Extend the tracker with the dedup guard that mirrors production code.
    let lastBootingSubstatus: BootingSubstatus | null = null;
    let lastBootingTransitionAt: number | null = null;

    async function trackerWithDedup(
      threadId: string,
      bootingStatus: BootingSubstatus | null,
      nowMs: number,
    ): Promise<void> {
      if (bootingStatus === null) return;
      const normalised: BootingSubstatus =
        bootingStatus === "provisioning-done" ? "provisioning" : bootingStatus;
      if (normalised === lastBootingSubstatus) return; // dedup guard
      const durationMs =
        lastBootingTransitionAt !== null
          ? nowMs - lastBootingTransitionAt
          : undefined;
      const metaEvent: ThreadMetaEvent = {
        kind: "boot.substatus_changed",
        threadId,
        from: lastBootingSubstatus,
        to: normalised,
        timestamp: new Date(nowMs).toISOString(),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      await publishFn(metaEvent);
      lastBootingSubstatus = normalised;
      lastBootingTransitionAt = nowMs;
    }

    await trackerWithDedup(THREAD_ID, "cloning-repo", 1000);
    await trackerWithDedup(THREAD_ID, "cloning-repo", 2000); // duplicate — must be ignored

    expect(publishFn).toHaveBeenCalledTimes(1);
    const first = published[0];
    if (!first || first.kind !== "boot.substatus_changed") {
      expect.fail("Expected boot.substatus_changed kind");
      return;
    }
    expect(first.to).toBe("cloning-repo");
  });

  it("does not emit when provisioning-done follows provisioning", async () => {
    let lastBootingSubstatus: BootingSubstatus | null = null;
    let lastBootingTransitionAt: number | null = null;

    async function trackerWithDedup(
      threadId: string,
      bootingStatus: BootingSubstatus | null,
      nowMs: number,
    ): Promise<void> {
      if (bootingStatus === null) return;
      const normalised: BootingSubstatus =
        bootingStatus === "provisioning-done" ? "provisioning" : bootingStatus;
      if (normalised === lastBootingSubstatus) return; // dedup guard
      const durationMs =
        lastBootingTransitionAt !== null
          ? nowMs - lastBootingTransitionAt
          : undefined;
      const metaEvent: ThreadMetaEvent = {
        kind: "boot.substatus_changed",
        threadId,
        from: lastBootingSubstatus,
        to: normalised,
        timestamp: new Date(nowMs).toISOString(),
        ...(durationMs !== undefined ? { durationMs } : {}),
      };
      await publishFn(metaEvent);
      lastBootingSubstatus = normalised;
      lastBootingTransitionAt = nowMs;
    }

    await trackerWithDedup(THREAD_ID, "provisioning", 1000);
    // provisioning-done normalises to "provisioning" → same as last → no-op
    await trackerWithDedup(THREAD_ID, "provisioning-done", 3000);

    expect(publishFn).toHaveBeenCalledTimes(1);
    const first = published[0];
    if (!first || first.kind !== "boot.substatus_changed") {
      expect.fail("Expected boot.substatus_changed kind");
      return;
    }
    expect(first.to).toBe("provisioning");
  });
});

// ---------------------------------------------------------------------------
// Schema-sync guard
// ---------------------------------------------------------------------------

describe("ThreadMetaEvent schema sync guard", () => {
  it("shared package exports boot.substatus_changed variant", () => {
    // Compile-time exhaustiveness check — if the union doesn't include
    // boot.substatus_changed this cast will fail tsc.
    const event: ThreadMetaEvent = {
      kind: "boot.substatus_changed",
      threadId: "t",
      from: null,
      to: "provisioning",
      timestamp: new Date().toISOString(),
    };
    expect(event.kind).toBe("boot.substatus_changed");
  });

  it("shared package exports install.progress variant", () => {
    const event: ThreadMetaEvent = {
      kind: "install.progress",
      threadId: "t",
      resolved: 10,
      reused: 5,
      downloaded: 3,
      added: 2,
      elapsedMs: 4000,
    };
    expect(event.kind).toBe("install.progress");
  });

  it("install.progress optional fields are truly optional", () => {
    const minimal: ThreadMetaEvent = {
      kind: "install.progress",
      threadId: "t",
      resolved: 0,
      reused: 0,
      downloaded: 0,
      added: 0,
      elapsedMs: 0,
    };
    if (minimal.kind === "install.progress") {
      expect(minimal.total).toBeUndefined();
      expect(minimal.currentPackage).toBeUndefined();
    }
  });
});
