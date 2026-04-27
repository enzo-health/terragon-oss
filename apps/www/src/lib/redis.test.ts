import { execSync } from "node:child_process";
import { nanoid } from "nanoid/non-secure";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getLocalHttpCommandTimeoutMs,
  isLocalRedisHttpMode,
  redis,
} from "./redis";

describe("getLocalHttpCommandTimeoutMs", () => {
  it("uses default timeout for non-blocking commands", () => {
    expect(getLocalHttpCommandTimeoutMs("get", ["key"])).toBe(3_000);
  });

  it("extends timeout for blocking XREAD commands", () => {
    expect(
      getLocalHttpCommandTimeoutMs("xread", [
        "BLOCK",
        "10000",
        "STREAMS",
        "agui:thread:123",
        "$",
      ]),
    ).toBe(12_000);
  });

  it("caps infinite BLOCK timeout to a bounded value", () => {
    expect(
      getLocalHttpCommandTimeoutMs("xread", [
        "BLOCK",
        "0",
        "STREAMS",
        "agui:thread:123",
        "$",
      ]),
    ).toBe(30_000);
  });

  it("reads block timeout from object-style xread options", () => {
    expect(
      getLocalHttpCommandTimeoutMs("xread", [
        "agui:thread:123",
        "$",
        { count: 32, blockMS: 10_000 },
      ]),
    ).toBe(12_000);
  });
});

describe("isLocalRedisHttpMode", () => {
  it("treats both local redis-http ports as local mode in development", () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousRedisUrl = process.env.REDIS_URL;
    try {
      mutableEnv.NODE_ENV = "development";

      mutableEnv.REDIS_URL = "http://localhost:8079";
      expect(isLocalRedisHttpMode()).toBe(true);

      mutableEnv.REDIS_URL = "http://localhost:18079";
      expect(isLocalRedisHttpMode()).toBe(true);
    } finally {
      mutableEnv.NODE_ENV = previousNodeEnv;
      if (previousRedisUrl === undefined) {
        delete mutableEnv.REDIS_URL;
      } else {
        mutableEnv.REDIS_URL = previousRedisUrl;
      }
    }
  });
});

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
