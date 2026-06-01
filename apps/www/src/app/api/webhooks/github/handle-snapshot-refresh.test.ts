import { describe, it, expect, vi, beforeEach } from "vitest";

const waitUntilPromises = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => {
    waitUntilPromises.push(promise);
    return promise;
  },
}));

vi.mock("@/lib/db", () => ({ db: {} }));

const getEnvironmentsByRepoFullName = vi.fn();
vi.mock("@terragon/shared/model/environments", () => ({
  getEnvironmentsByRepoFullName: (args: unknown) =>
    getEnvironmentsByRepoFullName(args),
  getEnvironmentsWithSnapshots: vi.fn(),
  markSnapshotsStale: vi.fn(),
}));

vi.mock("@terragon/sandbox/snapshot-builder", () => ({
  deleteRepoSnapshot: vi.fn(),
  listRepoSnapshotNames: vi.fn(),
}));

const triggerEnvironmentSnapshotBuild = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server-lib/environment-snapshot-trigger", () => ({
  triggerEnvironmentSnapshotBuild: (args: unknown) =>
    triggerEnvironmentSnapshotBuild(args),
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
  waitUntilPromises.length = 0;
});

describe("handlePushSnapshotRefresh", () => {
  it("force-refreshes each Daytona snapshot size for the repo's environments", async () => {
    getEnvironmentsByRepoFullName.mockResolvedValue([
      {
        id: "env-1",
        userId: "user-1",
        snapshots: [
          { provider: "daytona", size: "small", status: "ready" },
          { provider: "daytona", size: "large", status: "stale" },
        ],
      },
    ]);

    await handlePushSnapshotRefresh(pushPayload({}));
    await Promise.all(waitUntilPromises);

    expect(triggerEnvironmentSnapshotBuild).toHaveBeenCalledTimes(2);
    expect(triggerEnvironmentSnapshotBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        environmentId: "env-1",
        size: "small",
        force: true,
        buildReason: "github-base-push",
      }),
    );
    expect(triggerEnvironmentSnapshotBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        size: "large",
        force: true,
        buildReason: "github-base-push",
      }),
    );
  });

  it("ignores pushes to non-default branches", async () => {
    await handlePushSnapshotRefresh(
      pushPayload({ ref: "refs/heads/feature-x" }),
    );
    expect(getEnvironmentsByRepoFullName).not.toHaveBeenCalled();
    expect(triggerEnvironmentSnapshotBuild).not.toHaveBeenCalled();
  });

  it("ignores branch-deletion pushes", async () => {
    await handlePushSnapshotRefresh(pushPayload({ deleted: true }));
    expect(getEnvironmentsByRepoFullName).not.toHaveBeenCalled();
    expect(triggerEnvironmentSnapshotBuild).not.toHaveBeenCalled();
  });

  it("skips environments with no Daytona snapshot", async () => {
    getEnvironmentsByRepoFullName.mockResolvedValue([
      { id: "env-2", userId: "user-2", snapshots: [] },
      { id: "env-3", userId: "user-3", snapshots: null },
    ]);

    await handlePushSnapshotRefresh(pushPayload({}));
    await Promise.all(waitUntilPromises);

    expect(triggerEnvironmentSnapshotBuild).not.toHaveBeenCalled();
  });
});
