import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => promise,
}));

vi.mock("@/lib/db", () => ({ db: {} }));

const refreshEnvironmentSnapshotsForRepo = vi.fn().mockResolvedValue(0);
vi.mock("@/server-lib/environment-snapshot-lifecycle", () => ({
  refreshEnvironmentSnapshotsForRepo: (args: unknown) =>
    refreshEnvironmentSnapshotsForRepo(args),
}));

import { handlePushSnapshotRefresh } from "./handle-snapshot-refresh";

type PushPayload = Parameters<typeof handlePushSnapshotRefresh>[0];

function pushPayload(overrides: {
  ref?: string;
  deleted?: boolean;
  fullName?: string;
  defaultBranch?: string;
}): PushPayload {
  return {
    ref: overrides.ref ?? "refs/heads/main",
    deleted: overrides.deleted ?? false,
    repository: {
      full_name: overrides.fullName ?? "owner/repo",
      default_branch: overrides.defaultBranch ?? "main",
    },
  } as unknown as PushPayload;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handlePushSnapshotRefresh", () => {
  it("delegates default-branch push refresh to the snapshot lifecycle", async () => {
    await handlePushSnapshotRefresh(pushPayload({}));

    expect(refreshEnvironmentSnapshotsForRepo).toHaveBeenCalledWith({
      db: {},
      repoFullName: "owner/repo",
      baseBranch: "main",
      includeLegacyBranchless: true,
    });
  });

  it("delegates non-default branch pushes to refresh matching branch snapshots", async () => {
    await handlePushSnapshotRefresh(
      pushPayload({ ref: "refs/heads/feature/foo" }),
    );
    expect(refreshEnvironmentSnapshotsForRepo).toHaveBeenCalledWith({
      db: {},
      repoFullName: "owner/repo",
      baseBranch: "feature/foo",
      includeLegacyBranchless: false,
    });
  });

  it("ignores non-branch refs", async () => {
    await handlePushSnapshotRefresh(pushPayload({ ref: "refs/tags/v1.0.0" }));
    expect(refreshEnvironmentSnapshotsForRepo).not.toHaveBeenCalled();
  });

  it("ignores branch-deletion pushes", async () => {
    await handlePushSnapshotRefresh(pushPayload({ deleted: true }));
    expect(refreshEnvironmentSnapshotsForRepo).not.toHaveBeenCalled();
  });
});
