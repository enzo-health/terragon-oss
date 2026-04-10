import {
  SetupResult,
  setupTestContainers,
  teardownTestContainers,
} from "@leo/dev-env/test-global-setup";
import path from "path";
import { execSync } from "child_process";
import fs from "fs/promises";
import { unlinkSync } from "fs";
import os from "os";

const LOCK_PATH = path.join(os.tmpdir(), "leo-shared-test-setup.lock");
const LOCK_TIMEOUT_MS = 60_000;

let setupResult: SetupResult;
let releaseTestSetupLock: (() => Promise<void>) | null = null;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupLockOnExit() {
  try {
    unlinkSync(LOCK_PATH);
  } catch {}
  process.exit(1);
}

async function acquireTestSetupLock(): Promise<() => Promise<void>> {
  const startTime = Date.now();

  // Clean up lock on forced exit
  process.on("SIGINT", cleanupLockOnExit);
  process.on("SIGTERM", cleanupLockOnExit);

  while (true) {
    try {
      const handle = await fs.open(LOCK_PATH, "wx");
      await handle.writeFile(String(process.pid));
      return async () => {
        process.removeListener("SIGINT", cleanupLockOnExit);
        process.removeListener("SIGTERM", cleanupLockOnExit);
        await handle.close();
        await fs.unlink(LOCK_PATH).catch(() => undefined);
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }

      // Check if the lock is stale (owner process dead or timeout exceeded)
      let shouldForceAcquire = false;
      try {
        const content = await fs.readFile(LOCK_PATH, "utf-8");
        const pid = parseInt(content.trim(), 10);
        if (!isNaN(pid) && !isProcessAlive(pid)) {
          console.log(
            `Removing stale test setup lock (owner PID ${pid} is dead)`,
          );
          shouldForceAcquire = true;
        }
      } catch {
        // Lock file disappeared between check and read — retry will acquire it
      }

      if (!shouldForceAcquire && Date.now() - startTime > LOCK_TIMEOUT_MS) {
        console.log(
          `Test setup lock held for >${LOCK_TIMEOUT_MS}ms, forcing acquisition`,
        );
        shouldForceAcquire = true;
      }

      if (shouldForceAcquire) {
        await fs.unlink(LOCK_PATH).catch(() => undefined);
        // Loop back to try acquiring
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function setup() {
  releaseTestSetupLock = await acquireTestSetupLock();
  const start = Date.now();
  console.log("Starting test containers...");
  setupResult = await setupTestContainers();
  console.log(`Test containers started. (${Date.now() - start}ms)`);
  process.env.DATABASE_URL = setupResult.DATABASE_URL;
  process.env.REDIS_URL = setupResult.REDIS_HTTP_URL;
  process.env.REDIS_TOKEN = setupResult.REDIS_HTTP_TOKEN;

  // Applying drizzle schema to test database
  console.log("Applying drizzle schema to test database...");
  try {
    const result = execSync("pnpm drizzle-kit-push-test", {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        DATABASE_URL: setupResult.DATABASE_URL,
      },
    });
    console.log("Drizzle schema applied to test database.");
    console.log("Command output:", result.toString());
  } catch (error) {
    console.error("Error applying drizzle schema to test database.");
    console.error(
      "Error message:",
      error instanceof Error ? error.message : error,
    );
    throw error;
  }
}

export async function teardown() {
  try {
    await teardownTestContainers();
  } finally {
    if (releaseTestSetupLock) {
      await releaseTestSetupLock();
      releaseTestSetupLock = null;
    }
  }
}
