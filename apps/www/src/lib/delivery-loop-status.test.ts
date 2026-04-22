import { describe, expect, it } from "vitest";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import {
  classifyLivenessEvidence,
  getDeliveryLoopAwareThreadStatus,
  getWorkingFooterFreshness,
  isDeliveryLoopStateActivelyWorking,
  shouldUseDeliveryLoopHeadOverride,
  shouldRefreshDeliveryLoopStatusFromThreadPatch,
} from "./delivery-loop-status";

describe("delivery-loop-status runtime helpers", () => {
  describe("isDeliveryLoopStateActivelyWorking", () => {
    it("treats active execution phases as working", () => {
      expect(isDeliveryLoopStateActivelyWorking("planning")).toBe(true);
      expect(isDeliveryLoopStateActivelyWorking("implementing")).toBe(true);
      expect(isDeliveryLoopStateActivelyWorking("review_gate")).toBe(true);
      expect(isDeliveryLoopStateActivelyWorking("ci_gate")).toBe(true);
      expect(isDeliveryLoopStateActivelyWorking("babysitting")).toBe(true);
    });

    it("treats blocked, awaiting, and terminal phases as not working", () => {
      expect(isDeliveryLoopStateActivelyWorking("awaiting_pr_link")).toBe(
        false,
      );
      expect(isDeliveryLoopStateActivelyWorking("blocked")).toBe(false);
      expect(isDeliveryLoopStateActivelyWorking("done")).toBe(false);
      expect(isDeliveryLoopStateActivelyWorking("stopped")).toBe(false);
      expect(isDeliveryLoopStateActivelyWorking("terminated_pr_closed")).toBe(
        false,
      );
      expect(isDeliveryLoopStateActivelyWorking("terminated_pr_merged")).toBe(
        false,
      );
      expect(isDeliveryLoopStateActivelyWorking(null)).toBe(false);
    });
  });

  describe("getDeliveryLoopAwareThreadStatus", () => {
    const now = new Date("2026-04-22T00:05:00.000Z");

    it("upgrades inactive transport states to working when the loop is active and head evidence is fresh", () => {
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "complete",
          deliveryLoopState: "implementing",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:04:30.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
          now,
        }),
      ).toBe("working");
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "scheduled",
          deliveryLoopState: "planning",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:04:30.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
          now,
        }),
      ).toBe("working");
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: null,
          deliveryLoopState: "review_gate",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:04:30.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
          now,
        }),
      ).toBe("working");
    });

    it("preserves transport-specific working detail when it already exists (fresh head)", () => {
      // booting is overridden to working when delivery loop is active,
      // since stale booting status shouldn't show "Waiting for assistant"
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "booting",
          deliveryLoopState: "implementing",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:04:30.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
          now,
        }),
      ).toBe("working");
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "queued-agent-rate-limit",
          deliveryLoopState: "ci_gate",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:04:30.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
          now,
        }),
      ).toBe("queued-agent-rate-limit");
    });

    it("does not override non-working loop states", () => {
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "complete",
          deliveryLoopState: "awaiting_pr_link",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:04:30.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
          now,
        }),
      ).toBe("complete");
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "error",
          deliveryLoopState: "blocked",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:04:30.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
          now,
        }),
      ).toBe("error");
    });

    it("does not override when the workflow head evidence is stale", () => {
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "complete",
          deliveryLoopState: "implementing",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:00:00.000Z",
          threadChatUpdatedAt: "2026-04-22T00:04:59.000Z",
          now,
        }),
      ).toBe("complete");
    });

    it("does not override when chat evidence is as-new-or-newer than the workflow head", () => {
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "complete",
          deliveryLoopState: "implementing",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:04:00.000Z",
          threadChatUpdatedAt: "2026-04-22T00:04:30.000Z",
          now,
        }),
      ).toBe("complete");
    });
  });

  describe("liveness evidence helpers", () => {
    it("classifies the latest durable evidence as fresh within the window", () => {
      const now = new Date("2026-04-22T00:02:00.000Z");
      expect(
        classifyLivenessEvidence({
          now,
          threadChatUpdatedAt: "2026-04-22T00:01:30.000Z",
          deliveryLoopUpdatedAtIso: "2026-04-22T00:00:00.000Z",
        }).kind,
      ).toBe("fresh");
    });

    it("classifies the latest durable evidence as stale outside the window", () => {
      const now = new Date("2026-04-22T00:05:00.000Z");
      expect(
        classifyLivenessEvidence({
          now,
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
        }).kind,
      ).toBe("stale");
    });

    it("returns an uncertainty override for working candidates without fresh evidence", () => {
      const now = new Date("2026-04-22T00:05:00.000Z");
      expect(
        getWorkingFooterFreshness({
          now,
          isWorkingCandidate: true,
          threadChatUpdatedAt: "2026-04-22T00:01:00.000Z",
        }),
      ).toEqual({ kind: "uncertain", message: "Waiting for updates" });
    });

    it("does not override when the footer is not a working candidate", () => {
      const now = new Date("2026-04-22T00:05:00.000Z");
      expect(
        getWorkingFooterFreshness({
          now,
          isWorkingCandidate: false,
          threadChatUpdatedAt: "2026-04-22T00:00:00.000Z",
        }),
      ).toEqual({ kind: "fresh" });
    });

    it("does not allow a fresh-but-older workflow head to override newer chat evidence", () => {
      const now = new Date("2026-04-22T00:02:00.000Z");
      expect(
        shouldUseDeliveryLoopHeadOverride({
          now,
          deliveryLoopUpdatedAtIso: "2026-04-22T00:01:30.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:31.000Z",
        }),
      ).toBe(false);
    });

    it("allows the workflow head to override when it is fresh and strictly newer than chat evidence", () => {
      const now = new Date("2026-04-22T00:02:00.000Z");
      expect(
        shouldUseDeliveryLoopHeadOverride({
          now,
          deliveryLoopUpdatedAtIso: "2026-04-22T00:01:31.000Z",
          threadChatUpdatedAt: "2026-04-22T00:01:30.000Z",
        }),
      ).toBe(true);
    });
  });

  describe("shouldRefreshDeliveryLoopStatusFromThreadPatch", () => {
    it("refreshes for shell status changes, refetch, and agent-message patches", () => {
      const patches: BroadcastThreadPatch[] = [
        {
          threadId: "thread-1",
          op: "upsert",
          chat: {
            status: "working",
          },
        },
        {
          threadId: "thread-1",
          op: "upsert",
          refetch: ["shell"],
        },
        {
          threadId: "thread-1",
          op: "upsert",
          appendMessages: [
            {
              type: "agent",
            },
          ],
        },
      ];

      for (const patch of patches) {
        expect(shouldRefreshDeliveryLoopStatusFromThreadPatch(patch)).toBe(
          true,
        );
      }
    });

    it("ignores delta, delete, and user-only append patches", () => {
      const patches: BroadcastThreadPatch[] = [
        {
          threadId: "thread-1",
          op: "delta",
          messageId: "message-1",
          partIndex: 0,
          deltaSeq: 1,
          deltaIdempotencyKey: "delta-1",
          deltaKind: "text",
          text: "partial",
        },
        {
          threadId: "thread-1",
          op: "delete",
        },
        {
          threadId: "thread-1",
          op: "upsert",
          appendMessages: [
            {
              type: "user",
            },
          ],
        },
      ];

      for (const patch of patches) {
        expect(shouldRefreshDeliveryLoopStatusFromThreadPatch(patch)).toBe(
          false,
        );
      }
    });

    it("refreshes for PR link and status field changes (VAL-UI-004, VAL-UI-005)", () => {
      const patches: BroadcastThreadPatch[] = [
        {
          threadId: "thread-1",
          op: "upsert",
          shell: {
            prStatus: "open",
          },
        },
        {
          threadId: "thread-1",
          op: "upsert",
          shell: {
            githubPRNumber: 123,
          },
        },
        {
          threadId: "thread-1",
          op: "upsert",
          shell: {
            prChecksStatus: "pending",
          },
        },
      ];

      for (const patch of patches) {
        expect(shouldRefreshDeliveryLoopStatusFromThreadPatch(patch)).toBe(
          true,
        );
      }
    });

    it("ignores non-status shell field changes", () => {
      const patches: BroadcastThreadPatch[] = [
        {
          threadId: "thread-1",
          op: "upsert",
          shell: {
            name: "Updated name",
          },
        },
        {
          threadId: "thread-1",
          op: "upsert",
          shell: {
            updatedAt: new Date().toISOString(),
          },
        },
        {
          threadId: "thread-1",
          op: "upsert",
          shell: {
            codesandboxId: "new-sandbox-id",
          },
        },
      ];

      for (const patch of patches) {
        expect(shouldRefreshDeliveryLoopStatusFromThreadPatch(patch)).toBe(
          false,
        );
      }
    });
  });
});
