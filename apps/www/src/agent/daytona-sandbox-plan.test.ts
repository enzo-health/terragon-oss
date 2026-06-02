import { describe, expect, it, vi } from "vitest";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";

vi.mock("@terragon/sandbox/snapshot-builder", () => ({
  getSetupScriptHash: (script: string | null) =>
    script ? `setup:${script}` : "",
  getSnapshotBaseTemplateId: (size: string) => `base:${size}`,
}));

import {
  buildSnapshotRecipeFingerprint,
  type SnapshotRecipeFingerprint,
} from "@/server-lib/environment-snapshot-lifecycle";
import { resolveDaytonaSandboxBootPlan } from "./daytona-sandbox-plan";

function snapshot(
  overrides: Partial<EnvironmentSnapshot> & SnapshotRecipeFingerprint,
): EnvironmentSnapshot {
  return {
    provider: "daytona",
    size: "small",
    snapshotName: "repo-owner-repo-small",
    status: "ready",
    baseBranch: "main",
    builtAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveDaytonaSandboxBootPlan", () => {
  const fingerprint = buildSnapshotRecipeFingerprint({
    setupScript: "pnpm install",
    size: "small",
    environmentVariablesHash: "repo-env-hash",
    mcpConfigHash: "mcp-hash",
  });

  it("does not apply Daytona layers for non-Daytona providers", () => {
    expect(
      resolveDaytonaSandboxBootPlan({
        sandboxProvider: "docker",
        existingSandboxId: null,
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        repoFullName: "owner/repo",
        volumeEnabled: true,
        volumeName: "terragon-workspaces",
        sandboxSize: "small",
        baseBranch: "main",
        setupScript: "pnpm install",
        snapshots: [snapshot(fingerprint)],
        environmentVariablesHash: "repo-env-hash",
        mcpConfigHash: "mcp-hash",
      }),
    ).toEqual({
      daytonaVolume: undefined,
      volumeEnvironmentEntries: [],
      snapshotTemplateId: undefined,
      snapshotFingerprint: undefined,
    });
  });

  it("does not select snapshots while resuming an existing sandbox", () => {
    const plan = resolveDaytonaSandboxBootPlan({
      sandboxProvider: "daytona",
      existingSandboxId: "sandbox-1",
      userId: "user-1",
      environmentId: "env-1",
      threadId: "thread-1",
      repoFullName: "owner/repo",
      volumeEnabled: false,
      volumeName: "",
      sandboxSize: "small",
      baseBranch: "main",
      setupScript: "pnpm install",
      snapshots: [snapshot(fingerprint)],
      environmentVariablesHash: "repo-env-hash",
      mcpConfigHash: "mcp-hash",
    });

    expect(plan.snapshotTemplateId).toBeUndefined();
    expect(plan.snapshotFingerprint).toEqual(fingerprint);
  });

  it("selects a ready snapshot only when the setup recipe matches", () => {
    const plan = resolveDaytonaSandboxBootPlan({
      sandboxProvider: "daytona",
      existingSandboxId: null,
      userId: "user-1",
      environmentId: "env-1",
      threadId: "thread-1",
      repoFullName: "owner/repo",
      volumeEnabled: false,
      volumeName: "",
      sandboxSize: "small",
      baseBranch: "main",
      setupScript: "pnpm install",
      snapshots: [
        snapshot({ ...fingerprint, snapshotName: "matching-snapshot" }),
        snapshot({
          ...fingerprint,
          snapshotName: "wrong-env-snapshot",
          environmentVariablesHash: "global-env-hash",
        }),
      ],
      environmentVariablesHash: "repo-env-hash",
      mcpConfigHash: "mcp-hash",
    });

    expect(plan.snapshotTemplateId).toBe("matching-snapshot");
  });

  it("does not select a snapshot baked from a different base branch", () => {
    const plan = resolveDaytonaSandboxBootPlan({
      sandboxProvider: "daytona",
      existingSandboxId: null,
      userId: "user-1",
      environmentId: "env-1",
      threadId: "thread-1",
      repoFullName: "owner/repo",
      volumeEnabled: false,
      volumeName: "",
      sandboxSize: "small",
      baseBranch: "feature/foo",
      setupScript: "pnpm install",
      snapshots: [
        snapshot({
          ...fingerprint,
          snapshotName: "main-snapshot",
          baseBranch: "main",
        }),
        snapshot({
          ...fingerprint,
          snapshotName: "legacy-snapshot",
          baseBranch: undefined,
        }),
      ],
      environmentVariablesHash: "repo-env-hash",
      mcpConfigHash: "mcp-hash",
    });

    expect(plan.snapshotTemplateId).toBeUndefined();
  });

  it("uses a legacy branchless snapshot as a default-branch migration fallback", () => {
    const plan = resolveDaytonaSandboxBootPlan({
      sandboxProvider: "daytona",
      existingSandboxId: null,
      userId: "user-1",
      environmentId: "env-1",
      threadId: "thread-1",
      repoFullName: "owner/repo",
      volumeEnabled: false,
      volumeName: "",
      sandboxSize: "small",
      baseBranch: "main",
      setupScript: "pnpm install",
      snapshots: [
        snapshot({
          ...fingerprint,
          snapshotName: "legacy-snapshot",
          baseBranch: undefined,
        }),
      ],
      environmentVariablesHash: "repo-env-hash",
      mcpConfigHash: "mcp-hash",
    });

    expect(plan.snapshotTemplateId).toBe("legacy-snapshot");
  });

  it("keeps volume defaults ahead of user env so user env can override", () => {
    const plan = resolveDaytonaSandboxBootPlan({
      sandboxProvider: "daytona",
      existingSandboxId: null,
      userId: "user-1",
      environmentId: "env-1",
      threadId: "thread-1",
      repoFullName: "owner/repo",
      volumeEnabled: true,
      volumeName: "terragon-workspaces",
      sandboxSize: "small",
      baseBranch: "main",
      setupScript: "pnpm install",
      snapshots: [],
      environmentVariablesHash: "repo-env-hash",
      mcpConfigHash: "mcp-hash",
    });
    const userEnv = [{ key: "TURBO_CACHE_DIR", value: "/tmp/user-turbo" }];

    expect([...plan.volumeEnvironmentEntries, ...userEnv].at(-1)).toEqual({
      key: "TURBO_CACHE_DIR",
      value: "/tmp/user-turbo",
    });
  });
});
