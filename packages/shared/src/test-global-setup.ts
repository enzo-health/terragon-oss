import {
  SetupResult,
  setupTestContainers,
  teardownTestContainers,
} from "@terragon/dev-env/test-global-setup";
import path from "path";
import { execSync } from "child_process";
import fs from "fs/promises";
import os from "os";

let setupResult: SetupResult;
let releaseTestSetupLock: (() => Promise<void>) | null = null;

async function acquireTestSetupLock(): Promise<() => Promise<void>> {
  const lockPath = path.join(os.tmpdir(), "terragon-shared-test-setup.lock");

  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await fs.unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
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
