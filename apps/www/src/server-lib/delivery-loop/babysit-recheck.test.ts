import { beforeEach, describe, expect, it, vi } from "vitest";
import { recheckBabysitCompletion } from "./babysit-recheck";
import { getOctokitForApp } from "@/lib/github";
import { fetchUnresolvedReviewThreadCount } from "@/app/api/webhooks/github/handlers";
import { redis } from "@/lib/redis";

type RecheckDb = Parameters<typeof recheckBabysitCompletion>[0]["db"];

const state = vi.hoisted(() => {
  const insertedRows: Array<Record<string, unknown>> = [];
  const acceptedKeys = new Set<string>();
  let signalCounter = 0;

  const loopFindFirst = vi.fn();

  return {
    insertedRows,
    acceptedKeys,
    loopFindFirst,
    nextSignalId: () => {
      signalCounter += 1;
      return `signal-${signalCounter}`;
    },
    resetSignalCounter: () => {
      signalCounter = 0;
    },
  };
});

vi.mock("@/lib/redis", () => ({
  redis: {
    set: vi.fn(),
  },
}));

vi.mock("@/lib/github", () => ({
  getOctokitForApp: vi.fn(),
  parseRepoFullName: (repoFullName: string) => repoFullName.split("/"),
}));

vi.mock("@/app/api/webhooks/github/handlers", () => ({
  fetchUnresolvedReviewThreadCount: vi.fn(),
}));

vi.mock("@terragon/shared/db/schema", () => ({
  sdlcLoop: { id: "sdlcLoop.id" },
  sdlcLoopSignalInbox: { id: "sdlcLoopSignalInbox.id" },
}));

vi.mock("@terragon/shared/model/delivery-loop", () => ({
  SDLC_CAUSE_IDENTITY_VERSION: 1,
}));

function makeDb(): RecheckDb {
  return {
    query: {
      sdlcLoop: {
        findFirst: state.loopFindFirst,
      },
    },
    insert: vi.fn(() => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            state.insertedRows.push(row);
            const dedupeKey = `${row.canonicalCauseId}:${row.signalHeadShaOrNull}`;
            if (state.acceptedKeys.has(dedupeKey)) {
              return [];
            }
            state.acceptedKeys.add(dedupeKey);
            return [{ id: state.nextSignalId() }];
          },
        }),
      }),
    })),
  } as unknown as RecheckDb;
}

describe("recheckBabysitCompletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.insertedRows.length = 0;
    state.acceptedKeys.clear();
    state.resetSignalCounter();

    vi.mocked(redis.set).mockResolvedValue("OK");
    state.loopFindFirst.mockResolvedValue({
      id: "loop-1",
      state: "babysitting",
      repoFullName: "owner/repo",
      prNumber: 63,
      currentHeadSha: "head-sha-123",
    });

    vi.mocked(getOctokitForApp).mockResolvedValue({
      rest: {
        checks: {
          listForRef: vi.fn().mockResolvedValue({
            data: {
              check_runs: [
                {
                  name: "CI / lint",
                  status: "completed",
                  conclusion: "success",
                },
                {
                  name: "CI / test",
                  status: "completed",
                  conclusion: "failure",
                },
              ],
            },
          }),
        },
      },
    } as unknown as Awaited<ReturnType<typeof getOctokitForApp>>);

    vi.mocked(fetchUnresolvedReviewThreadCount).mockResolvedValue(2);
  });

  it("inserts deterministic CI/review signals with signalHeadShaOrNull", async () => {
    const result = await recheckBabysitCompletion({
      db: makeDb(),
      loopId: "loop-1",
    });

    expect(result).toEqual({
      action: "signals_inserted",
      signalIds: ["signal-1", "signal-2"],
    });
    expect(state.insertedRows).toHaveLength(2);

    expect(state.insertedRows[0]).toMatchObject({
      loopId: "loop-1",
      causeType: "check_suite.completed",
      canonicalCauseId: "babysit-recheck:ci:loop-1:head-sha-123",
      signalHeadShaOrNull: "head-sha-123",
    });
    expect(
      (state.insertedRows[0]?.payload as Record<string, unknown>)?.headSha,
    ).toBe("head-sha-123");

    expect(state.insertedRows[1]).toMatchObject({
      loopId: "loop-1",
      causeType: "pull_request_review",
      canonicalCauseId: "babysit-recheck:review:loop-1:head-sha-123",
      signalHeadShaOrNull: "head-sha-123",
    });
    expect(
      (state.insertedRows[1]?.payload as Record<string, unknown>)?.headSha,
    ).toBe("head-sha-123");
  });

  it("deduplicates repeated rechecks for same loop/head via onConflictDoNothing", async () => {
    const db = makeDb();

    const first = await recheckBabysitCompletion({ db, loopId: "loop-1" });
    const second = await recheckBabysitCompletion({ db, loopId: "loop-1" });

    expect(first).toEqual({
      action: "signals_inserted",
      signalIds: ["signal-1", "signal-2"],
    });
    expect(second).toEqual({
      action: "no_signal_needed",
      reason: "ci_signal_deduplicated+review_signal_deduplicated",
    });

    const canonicalIds = state.insertedRows.map((row) => row.canonicalCauseId);
    expect(canonicalIds).toEqual([
      "babysit-recheck:ci:loop-1:head-sha-123",
      "babysit-recheck:review:loop-1:head-sha-123",
      "babysit-recheck:ci:loop-1:head-sha-123",
      "babysit-recheck:review:loop-1:head-sha-123",
    ]);
  });
});
