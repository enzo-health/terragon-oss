import { execSync } from "child_process";
import path from "path";

export type SetupResult = {
  DATABASE_URL: string;
  REDIS_URL: string;
  REDIS_HTTP_URL: string;
  REDIS_HTTP_TOKEN: string;
};

const REDIS_HTTP_TOKEN = "redis_test_token";
const COMPOSE_FILE_DIR = path.join(__dirname, "..");

export async function setupTestContainers(): Promise<SetupResult> {
  console.log("Starting test containers...");
  // Start the containers using the pnpm script (this is idempotent)
  execSync("pnpm docker-up-tests", {
    cwd: COMPOSE_FILE_DIR,
    stdio: "inherit",
  });

  // Clear existing data for clean test state
  try {
    // Clear PostgreSQL database
    execSync(
      'docker exec leo_postgres_test psql -U postgres -d postgres -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"',
      {
        stdio: "inherit",
      },
    );
    // Clear Redis data
    execSync("docker exec leo_redis_test redis-cli FLUSHALL", {
      stdio: "inherit",
    });
  } catch (error) {
    console.warn("Failed to clear test data:", error);
  }

  return {
    DATABASE_URL: "postgresql://postgres:postgres@localhost:15432/postgres",
    REDIS_URL: "redis://localhost:16379",
    REDIS_HTTP_URL: "http://localhost:18079",
    REDIS_HTTP_TOKEN,
  };
}

export async function teardownTestContainers(): Promise<void> {
  // Skip teardown to keep containers running for faster subsequent test runs
  // Data is cleared in setup, so this provides clean test state while maintaining speed
}
