import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  applyEnvironmentSnapshotBuildCompletion,
  completeEnvironmentSnapshotBuild,
  getEnvironment,
  updateEnvironment,
  getOrCreateEnvironment,
  isSnapshotBuildStale,
  reapStaleBuildingSnapshots,
  getReadySnapshot,
  SNAPSHOT_BUILD_TIMEOUT_MS,
} from "./environments";
import type { EnvironmentSnapshot } from "../db/schema";
import { createTestUser } from "./test-helpers";

function buildSnapshot(
  overrides: Partial<EnvironmentSnapshot> = {},
): EnvironmentSnapshot {
  return {
    provider: "daytona",
    size: "large",
    snapshotName: "",
    status: "building",
    setupScriptHash: "setup-hash",
    baseDockerfileHash: "base-hash",
    builtAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("environments", () => {
  let db: DB;
  let userId: string;
  let environmentId: string;

  beforeEach(async () => {
    // Use the test database URL from environment (set by test setup)
    const testDbUrl = process.env.DATABASE_URL!;
    db = createDb(testDbUrl);

    // Create a test user
    const { user } = await createTestUser({ db });
    userId = user.id;

    // Create a test environment
    const [environment] = await db
      .insert(schema.environment)
      .values({
        userId,
        repoFullName: "test-org/test-repo",
      })
      .returning();
    environmentId = environment!.id;
  });

  describe("setup script functionality", () => {
    it("should save setup script to environment", async () => {
      const setupScript = `#!/bin/bash
echo "Running custom environment setup"
npm install
npm run build
echo "Setup complete!"`;

      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript,
        },
      });

      const updatedEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      expect(updatedEnvironment).toBeDefined();
      expect(updatedEnvironment?.setupScript).toBe(setupScript);
    });

    it("should allow null setup script to remove it", async () => {
      // First add a setup script
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: "echo 'test'",
        },
      });

      // Then remove it
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: null,
        },
      });

      const updatedEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      expect(updatedEnvironment?.setupScript).toBeNull();
    });

    it("should not affect other environment fields when updating setup script", async () => {
      // Add some environment variables first
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          environmentVariables: [
            { key: "API_KEY", valueEncrypted: "encrypted_value" },
          ],
        },
      });

      // Update only the setup script
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: "echo 'new setup script'",
        },
      });

      const updatedEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      // Environment variables should remain unchanged
      expect(updatedEnvironment?.environmentVariables).toHaveLength(1);
      expect(updatedEnvironment?.environmentVariables?.[0]?.key).toBe(
        "API_KEY",
      );
      expect(updatedEnvironment?.setupScript).toBe("echo 'new setup script'");
    });

    it("should handle multi-line setup scripts with special characters", async () => {
      const complexScript = `#!/bin/bash
set -e

# Setup environment variables
export NODE_ENV="production"
export API_URL="https://api.example.com"

# Install dependencies
echo "Installing dependencies..."
npm ci --production

# Run database migrations
if [ "$RUN_MIGRATIONS" = "true" ]; then
  echo "Running migrations..."
  npm run db:migrate
fi

# Build the application
npm run build

# Special characters test
echo 'Testing "quotes" and $variables'
echo "Path: \${PWD}"

# Exit successfully
exit 0`;

      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: complexScript,
        },
      });

      const updatedEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      expect(updatedEnvironment?.setupScript).toBe(complexScript);
    });

    it("should only allow user to update their own environment", async () => {
      const otherUserId = "other-user-456";

      // Should return null when trying to get another user's environment
      const environment = await getEnvironment({
        db,
        userId: otherUserId,
        environmentId,
      });

      expect(environment).toBeUndefined();

      // Update should not affect the environment
      await updateEnvironment({
        db,
        userId: otherUserId,
        environmentId,
        updates: {
          setupScript: "malicious script",
        },
      });

      // Original user should still see unchanged environment
      const originalEnvironment = await getEnvironment({
        db,
        userId,
        environmentId,
      });

      expect(originalEnvironment?.setupScript).toBeNull();
    });
  });

  describe("snapshot staleness", () => {
    const now = Date.parse("2026-05-25T20:00:00.000Z");

    it("treats a fresh building entry as not stale", () => {
      const fresh = buildSnapshot({
        status: "building",
        builtAt: new Date(now - 60_000).toISOString(),
      });
      expect(isSnapshotBuildStale(fresh, now)).toBe(false);
    });

    it("treats a building entry past the timeout as stale", () => {
      const old = buildSnapshot({
        status: "building",
        builtAt: new Date(now - SNAPSHOT_BUILD_TIMEOUT_MS - 1).toISOString(),
      });
      expect(isSnapshotBuildStale(old, now)).toBe(true);
    });

    it("never treats ready/failed/stale entries as stale builds", () => {
      for (const status of ["ready", "failed", "stale"] as const) {
        const snapshot = buildSnapshot({
          status,
          builtAt: new Date(now - SNAPSHOT_BUILD_TIMEOUT_MS * 10).toISOString(),
        });
        expect(isSnapshotBuildStale(snapshot, now)).toBe(false);
      }
    });

    it("treats an unparseable builtAt as stale", () => {
      const broken = buildSnapshot({
        status: "building",
        builtAt: "not-a-date",
      });
      expect(isSnapshotBuildStale(broken, now)).toBe(true);
    });

    it("flips only stale building entries to failed, leaving others intact", async () => {
      const staleLarge = buildSnapshot({
        size: "large",
        status: "building",
        builtAt: new Date(now - SNAPSHOT_BUILD_TIMEOUT_MS - 1).toISOString(),
      });
      const readySmall = buildSnapshot({
        size: "small",
        status: "ready",
        snapshotName: "repo-ready-small",
        builtAt: new Date(now - 5_000).toISOString(),
      });
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: { snapshots: [staleLarge, readySmall] },
      });

      const reaped = await reapStaleBuildingSnapshots({
        db,
        environmentId,
        userId,
        now,
      });

      const large = reaped.find((s) => s.size === "large");
      const small = reaped.find((s) => s.size === "small");
      expect(large?.status).toBe("failed");
      expect(large?.error).toMatch(/timed out|interrupted/i);
      expect(small?.status).toBe("ready");
      // The ready snapshot remains resolvable after reaping.
      expect(
        getReadySnapshot({ snapshots: reaped }, "daytona", "small")
          ?.snapshotName,
      ).toBe("repo-ready-small");
    });

    it("leaves a fresh building entry untouched", async () => {
      const freshBuilding = buildSnapshot({
        size: "large",
        status: "building",
        builtAt: new Date(now - 60_000).toISOString(),
      });
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: { snapshots: [freshBuilding] },
      });

      const reaped = await reapStaleBuildingSnapshots({
        db,
        environmentId,
        userId,
        now,
      });

      expect(reaped[0]?.status).toBe("building");
    });
  });

  describe("snapshot build completion", () => {
    it("only applies a completion to the matching active build", () => {
      const active = buildSnapshot({
        size: "large",
        status: "building",
        buildId: "build-active",
      });
      const small = buildSnapshot({
        size: "small",
        status: "ready",
        snapshotName: "ready-small",
      });
      const ready = buildSnapshot({
        size: "large",
        status: "ready",
        snapshotName: "ready-large",
        buildId: "build-active",
      });

      const applied = applyEnvironmentSnapshotBuildCompletion({
        snapshots: [active, small],
        snapshot: ready,
        expectedBuildId: "build-active",
      });

      expect(applied.applied).toBe(true);
      expect(applied.snapshots).toEqual([ready, small]);
      expect(applied.currentSnapshot).toEqual(active);
    });

    it("rejects a stale completion when the active build changed", () => {
      const newer = buildSnapshot({
        status: "building",
        buildId: "build-newer",
      });
      const staleReady = buildSnapshot({
        status: "ready",
        snapshotName: "stale-ready",
        buildId: "build-stale",
      });

      const applied = applyEnvironmentSnapshotBuildCompletion({
        snapshots: [newer],
        snapshot: staleReady,
        expectedBuildId: "build-stale",
      });

      expect(applied.applied).toBe(false);
      expect(applied.snapshots).toEqual([newer]);
      expect(applied.currentSnapshot).toEqual(newer);
    });

    it("persists a matching build completion and leaves stale completions untouched", async () => {
      const active = buildSnapshot({
        status: "building",
        buildId: "build-active",
      });
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: { snapshots: [active] },
      });

      const stale = buildSnapshot({
        status: "ready",
        snapshotName: "stale-ready",
        buildId: "build-stale",
      });
      const staleResult = await completeEnvironmentSnapshotBuild({
        db,
        userId,
        environmentId,
        snapshot: stale,
        expectedBuildId: "build-stale",
      });

      expect(staleResult.applied).toBe(false);
      expect(
        (await getEnvironment({ db, userId, environmentId }))?.snapshots,
      ).toEqual([active]);

      const ready = buildSnapshot({
        status: "ready",
        snapshotName: "ready-large",
        buildId: "build-active",
      });
      const readyResult = await completeEnvironmentSnapshotBuild({
        db,
        userId,
        environmentId,
        snapshot: ready,
        expectedBuildId: "build-active",
      });

      expect(readyResult.applied).toBe(true);
      expect(
        (await getEnvironment({ db, userId, environmentId }))?.snapshots,
      ).toEqual([ready]);
    });

    it("allows unrelated snapshot slots to complete concurrently", async () => {
      const activeSmall = buildSnapshot({
        size: "small",
        status: "building",
        buildId: "build-small",
      });
      const activeLarge = buildSnapshot({
        size: "large",
        status: "building",
        buildId: "build-large",
      });
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: { snapshots: [activeSmall, activeLarge] },
      });

      const readySmall = buildSnapshot({
        size: "small",
        status: "ready",
        snapshotName: "ready-small",
        buildId: "build-small",
      });
      const readyLarge = buildSnapshot({
        size: "large",
        status: "ready",
        snapshotName: "ready-large",
        buildId: "build-large",
      });

      const [smallResult, largeResult] = await Promise.all([
        completeEnvironmentSnapshotBuild({
          db,
          userId,
          environmentId,
          snapshot: readySmall,
          expectedBuildId: "build-small",
        }),
        completeEnvironmentSnapshotBuild({
          db,
          userId,
          environmentId,
          snapshot: readyLarge,
          expectedBuildId: "build-large",
        }),
      ]);

      expect(smallResult.applied).toBe(true);
      expect(largeResult.applied).toBe(true);
      expect(
        (await getEnvironment({ db, userId, environmentId }))?.snapshots,
      ).toEqual([readySmall, readyLarge]);
    });
  });

  describe("getOrCreateEnvironment", () => {
    it("should create environment with null setup script by default", async () => {
      const newRepoFullName = "test-org/new-repo";

      const environment = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: newRepoFullName,
      });

      expect(environment).toBeDefined();
      expect(environment.userId).toBe(userId);
      expect(environment.repoFullName).toBe(newRepoFullName);
      expect(environment.setupScript).toBeNull();
    });

    it("should return existing environment with setup script", async () => {
      // Add setup script to existing environment
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          setupScript: "echo 'existing script'",
        },
      });

      // Get or create should return the existing one
      const environment = await getOrCreateEnvironment({
        db,
        userId,
        repoFullName: "test-org/test-repo",
      });

      expect(environment.id).toBe(environmentId);
      expect(environment.setupScript).toBe("echo 'existing script'");
    });
  });
});
