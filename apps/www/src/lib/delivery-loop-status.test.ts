import { describe, expect, it } from "vitest";
import type { BroadcastThreadPatch } from "@terragon/types/broadcast";
import {
  getDeliveryLoopAwareThreadStatus,
  isDeliveryLoopStateActivelyWorking,
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
    it("upgrades inactive transport states to working when the loop is active", () => {
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "complete",
          deliveryLoopState: "implementing",
        }),
      ).toBe("working");
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "scheduled",
          deliveryLoopState: "planning",
        }),
      ).toBe("working");
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: null,
          deliveryLoopState: "review_gate",
        }),
      ).toBe("working");
    });

    it("preserves transport-specific working detail when it already exists", () => {
      // booting is overridden to working when delivery loop is active,
      // since stale booting status shouldn't show "Waiting for assistant"
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "booting",
          deliveryLoopState: "implementing",
        }),
      ).toBe("working");
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "queued-agent-rate-limit",
          deliveryLoopState: "ci_gate",
        }),
      ).toBe("queued-agent-rate-limit");
    });

    it("does not override non-working loop states", () => {
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "complete",
          deliveryLoopState: "awaiting_pr_link",
        }),
      ).toBe("complete");
      expect(
        getDeliveryLoopAwareThreadStatus({
          threadStatus: "error",
          deliveryLoopState: "blocked",
        }),
      ).toBe("error");
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
