import { beforeAll, describe, expect, it } from "vitest";
import { redis } from "./redis";
import { nanoid } from "nanoid/non-secure";
import { execSync } from "node:child_process";

describe("redis", { timeout: 60_000 }, () => {
  beforeAll(() => {
    execSync("docker restart terragon_redis_http_test", { stdio: "ignore" });
  });

  // This test is just to make sure that the redis and redis-http containers are
  // setup correctly in tests & CI.
  it("get and set works", async () => {
    const key = nanoid();
    const attempts = 10;
    const retryDelayMs = 250;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const v1 = await redis.get(key);
        await redis.set(key, "value");
        const v2 = await redis.get(key);
        expect(v1).toBeNull();
        expect(v2).toBe("value");
        return;
      } catch (error) {
        lastError = error;
        if (attempt === attempts - 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    throw lastError;
  });
});
