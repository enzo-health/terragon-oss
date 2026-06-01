import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type DB } from "../db";
import * as schema from "../db/schema";
import {
  getEnvironment,
  updateEnvironment,
  getOrCreateEnvironment,
  isSnapshotBuildStale,
  reapStaleBuildingSnapshots,
  getReadySnapshot,
  SNAPSHOT_BUILD_TIMEOUT_MS,
  markSnapshotsStale,
  updateEnvironmentSnapshot,
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

    it("marks ready snapshots stale without changing failed or building entries", async () => {
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          snapshots: [
            buildSnapshot({
              size: "small",
              status: "ready",
              snapshotName: "ready-small",
            }),
            buildSnapshot({
              size: "large",
              status: "building",
              snapshotName: "",
            }),
            buildSnapshot({
              size: "large",
              status: "failed",
              snapshotName: "",
              error: "failed",
            }),
          ],
        },
      });

      await markSnapshotsStale({ db, userId, environmentId });

      const environment = await getEnvironment({ db, userId, environmentId });
      expect(environment?.snapshots).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            snapshotName: "ready-small",
            status: "stale",
          }),
          expect.objectContaining({ status: "building" }),
          expect.objectContaining({ status: "failed" }),
        ]),
      );
    });

    it("replaces snapshots by provider and size when updating a snapshot slot", async () => {
      await updateEnvironment({
        db,
        userId,
        environmentId,
        updates: {
          snapshots: [
            buildSnapshot({
              size: "small",
              status: "ready",
              snapshotName: "old-small",
            }),
            buildSnapshot({
              size: "large",
              status: "ready",
              snapshotName: "large",
            }),
          ],
        },
      });

      await updateEnvironmentSnapshot({
        db,
        userId,
        environmentId,
        snapshot: buildSnapshot({
          size: "small",
          status: "ready",
          snapshotName: "new-small",
        }),
      });

      const environment = await getEnvironment({ db, userId, environmentId });
      expect(environment?.snapshots).toEqual([
        expect.objectContaining({ size: "small", snapshotName: "new-small" }),
        expect.objectContaining({ size: "large", snapshotName: "large" }),
      ]);
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
