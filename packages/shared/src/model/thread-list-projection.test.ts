import { describe, expect, it } from "vitest";
import type { ThreadInfo } from "../db/types";
import {
  applyThreadListProjectionPatch,
  buildThreadListProjectionFromPatch,
  compareThreadListProjection,
  isValidThreadListFilter,
  matchesThreadListProjectionFilter,
  parseThreadListProjectionFilter,
  shouldReplaceThreadListProjectionSeed,
} from "./thread-list-projection";

function makeThreadInfo(overrides: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: "thread-1",
    userId: "user-1",
    name: "Task",
    githubRepoFullName: "terragon/oss",
    githubPRNumber: null,
    githubIssueNumber: null,
    codesandboxId: "sandbox-1",
    sandboxProvider: "e2b",
    sandboxSize: "small",
    sandboxStatus: "running",
    bootingSubstatus: null,
    createdAt: new Date("2026-05-31T00:00:00.000Z"),
    updatedAt: new Date("2026-05-31T00:00:00.000Z"),
    repoBaseBranchName: "main",
    branchName: "feature/task",
    archived: false,
    automationId: null,
    parentThreadId: null,
    parentToolId: null,
    draftMessage: null,
    disableGitCheckpointing: false,
    skipSetup: false,
    sourceType: "www",
    sourceMetadata: { type: "www" },
    version: 1,
    gitDiffStats: null,
    authorName: "Tyler",
    authorImage: null,
    prStatus: null,
    prChecksStatus: null,
    visibility: "private",
    isUnread: false,
    messageSeq: 1,
    threadChats: [
      {
        id: "chat-1",
        agent: "claudeCode",
        status: "queued",
        errorMessage: null,
      },
    ],
    ...overrides,
  };
}

describe("thread list projection policy", () => {
  it("parses valid filters from unknown query-key values", () => {
    expect(
      parseThreadListProjectionFilter({
        archived: true,
        automationId: "automation-1",
        limit: 50,
      }),
    ).toEqual({
      archived: true,
      automationId: "automation-1",
      limit: 50,
    });
  });

  it("rejects malformed filters", () => {
    expect(isValidThreadListFilter({ archived: "yes" })).toBe(false);
    expect(isValidThreadListFilter({ automationId: 123 })).toBe(false);
    expect(isValidThreadListFilter({ limit: 0 })).toBe(false);
    expect(isValidThreadListFilter("archived")).toBe(false);
  });

  it("matches archived and automation filters without treating limit as a predicate", () => {
    const thread = {
      archived: false,
      automationId: "automation-1",
    };

    expect(
      matchesThreadListProjectionFilter(thread, {
        archived: false,
        automationId: "automation-1",
        limit: 1,
      }),
    ).toBe(true);
    expect(matchesThreadListProjectionFilter(thread, { archived: true })).toBe(
      false,
    );
    expect(
      matchesThreadListProjectionFilter(thread, {
        automationId: "automation-2",
      }),
    ).toBe(false);
  });

  it("orders by updatedAt descending then id descending", () => {
    const threads = [
      { id: "thread-a", updatedAt: new Date("2026-05-31T00:00:00.000Z") },
      { id: "thread-c", updatedAt: new Date("2026-05-31T00:00:00.000Z") },
      { id: "thread-b", updatedAt: new Date("2026-05-31T00:00:01.000Z") },
    ];

    expect(
      threads.toSorted(compareThreadListProjection).map((item) => item.id),
    ).toEqual(["thread-b", "thread-c", "thread-a"]);
  });

  it("builds shell inserts with chat updatedAt as the effective list timestamp", () => {
    const thread = buildThreadListProjectionFromPatch({
      now: new Date("2026-05-31T00:00:00.000Z"),
      patch: {
        threadId: "thread-2",
        threadChatId: "chat-2",
        op: "upsert",
        shell: {
          userId: "user-1",
          updatedAt: "2026-05-31T00:00:02.000Z",
        },
        chat: {
          updatedAt: "2026-05-31T00:00:05.000Z",
          status: "working",
        },
      },
    });

    expect(thread?.updatedAt.toISOString()).toBe("2026-05-31T00:00:05.000Z");
    expect(thread?.threadChats[0]?.status).toBe("working");
  });

  it("keeps list updatedAt monotonic when stale shell patches arrive", () => {
    const thread = makeThreadInfo({
      updatedAt: new Date("2026-05-31T00:00:10.000Z"),
    });
    const updated = applyThreadListProjectionPatch(thread, {
      threadId: "thread-1",
      op: "upsert",
      shell: {
        userId: "user-1",
        name: "Renamed",
        updatedAt: "2026-05-31T00:00:01.000Z",
      },
    });

    expect(updated.name).toBe("Renamed");
    expect(updated.updatedAt.toISOString()).toBe("2026-05-31T00:00:10.000Z");
  });

  it("guards collection seeds by list freshness", () => {
    const existing = makeThreadInfo({
      version: 2,
      messageSeq: 2,
      updatedAt: new Date("2026-05-31T00:00:10.000Z"),
    });
    const stale = makeThreadInfo({
      version: 3,
      messageSeq: 3,
      updatedAt: new Date("2026-05-31T00:00:01.000Z"),
    });
    const fresherSequence = makeThreadInfo({
      version: 1,
      messageSeq: 3,
      updatedAt: existing.updatedAt,
    });

    expect(shouldReplaceThreadListProjectionSeed(existing, stale)).toBe(false);
    expect(
      shouldReplaceThreadListProjectionSeed(existing, fresherSequence),
    ).toBe(true);
  });
});
