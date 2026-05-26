import { execSync } from "child_process";
import fs from "fs";
import os from "os";
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

  // Clear existing data for clean test state.
  // We truncate tables instead of dropping the schema so that concurrent test
  // suites (or a suite that is already running when another starts) do not
  // see "relation does not exist" errors while the schema is being rebuilt.
  try {
    // Clear PostgreSQL database — truncate all tables preserving schema.
    // Write SQL to a temp file to avoid shell escaping issues with $$.
    const tmpFile = path.join(
      os.tmpdir(),
      `terragon-test-truncate-${Date.now()}.sql`,
    );
    fs.writeFileSync(
      tmpFile,
      `DO $$ DECLARE r RECORD; BEGIN ` +
        `FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP ` +
        `EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' CASCADE'; ` +
        `END LOOP; END $$;`,
    );
    execSync(
      `docker cp "${tmpFile}" terragon_postgres_test:/tmp/truncate.sql && ` +
        `docker exec terragon_postgres_test psql -U postgres -d postgres -f /tmp/truncate.sql`,
      {
        stdio: "inherit",
      },
    );
    fs.unlinkSync(tmpFile);
    // Clear Redis data
    execSync("docker exec terragon_redis_test redis-cli FLUSHALL", {
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
