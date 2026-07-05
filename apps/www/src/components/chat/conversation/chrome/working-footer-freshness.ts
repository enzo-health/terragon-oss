import type { ThreadStatus } from "@terragon/shared";
import { isQueuedStatus } from "@/agent/thread-status";

type WorkingFooterFreshness =
  | { kind: "fresh" }
  | { kind: "uncertain"; message: string };

function parseDateLike(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getWorkingFooterFreshness(params: {
  now: Date;
  isWorkingCandidate: boolean;
  threadChatUpdatedAt?: Date | string | null;
  uncertainMessage: string;
}): WorkingFooterFreshness {
  if (!params.isWorkingCandidate) {
    return { kind: "fresh" };
  }
  const threadChatUpdatedAt = parseDateLike(params.threadChatUpdatedAt);
  if (
    threadChatUpdatedAt &&
    params.now.getTime() - threadChatUpdatedAt.getTime() <= 5 * 60 * 1_000
  ) {
    return { kind: "fresh" };
  }
  return { kind: "uncertain", message: params.uncertainMessage };
}

export function getWorkingMessageSlotClassName({
  threadStatus,
}: {
  threadStatus: ThreadStatus | null;
}): string {
  return threadStatus === "booting"
    ? "min-h-[168px]"
    : "min-h-11 flex items-start";
}

export function shouldSuppressPreStartLifecycleFooter(params: {
  threadStatus: ThreadStatus | null;
  hasAgentMessages: boolean;
}): boolean {
  const { threadStatus, hasAgentMessages } = params;
  if (!hasAgentMessages || threadStatus === null) {
    return false;
  }
  return threadStatus === "booting" || isQueuedStatus(threadStatus);
}
