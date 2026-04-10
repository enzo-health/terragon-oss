import { describe, it, expect } from "vitest";
import { ThreadStatus } from "@leo/shared";
import {
  sortThreadsUpdatedAt,
  MinimalThreadInfoForSorting,
} from "./thread-sorting";

const baseTime = new Date("2024-01-01T12:00:00.000Z").getTime();

function makeThread({
  label,
  createdOffset,
  updatedOffset,
  status = "complete",
}: {
  label: string;
  createdOffset: number;
  updatedOffset: number;
  status?: ThreadStatus;
}): MinimalThreadInfoForSorting & { label: string } {
  return {
    label,
    createdAt: new Date(baseTime + createdOffset),
    updatedAt: new Date(baseTime + updatedOffset),
    threadChats: [{ status }],
  };
}

describe("sortThreadsUpdatedAt", () => {
  it("keeps working threads stable by createdAt when updates are within a minute", () => {
    const threads = [
      makeThread({
        label: "newer-created",
        createdOffset: 10_000,
        updatedOffset: 50_000,
        status: "working",
      }),
      makeThread({
        label: "older-created",
        createdOffset: 0,
        updatedOffset: 55_000,
        status: "working",
      }),
    ];

    const result = sortThreadsUpdatedAt(threads);

    expect(result).not.toBe(threads);
    expect(result.map((thread) => thread.label)).toEqual([
      "newer-created",
      "older-created",
    ]);
  });

  it("sorts working threads by updatedAt when more than a minute apart", () => {
    const threads = [
      makeThread({
        label: "older-update",
        createdOffset: 0,
        updatedOffset: 0,
        status: "working",
      }),
      makeThread({
        label: "newer-update",
        createdOffset: 5_000,
        updatedOffset: 90_000,
        status: "working",
      }),
    ];

    const result = sortThreadsUpdatedAt(threads);

    expect(result.map((thread) => thread.label)).toEqual([
      "newer-update",
      "older-update",
    ]);
  });

  it("falls back to updatedAt when only one thread is working", () => {
    const threads = [
      makeThread({
        label: "working-thread",
        createdOffset: 0,
        updatedOffset: 30_000,
        status: "working",
      }),
      makeThread({
        label: "idle-thread",
        createdOffset: 5_000,
        updatedOffset: 31_000,
        status: "complete",
      }),
    ];

    const result = sortThreadsUpdatedAt(threads);

    expect(result.map((thread) => thread.label)).toEqual([
      "idle-thread",
      "working-thread",
    ]);
  });

  it("sorts non-working threads by updatedAt descending", () => {
    const threads = [
      makeThread({
        label: "less-recent",
        createdOffset: 0,
        updatedOffset: 10_000,
        status: "complete",
      }),
      makeThread({
        label: "most-recent",
        createdOffset: 5_000,
        updatedOffset: 20_000,
        status: "complete",
      }),
    ];

    const result = sortThreadsUpdatedAt(threads);

    expect(result.map((thread) => thread.label)).toEqual([
      "most-recent",
      "less-recent",
    ]);
  });
});
