import { describe, it, expect, vi, beforeEach } from "vitest";
import { runQualityCheckGateInSandbox } from "./quality-check-gate";
import type { ISandboxSession } from "@terragon/sandbox/types";

function createMockSession(
  overrides: Partial<{
    runCommandResults: Record<string, string | Error>;
  }> = {},
): ISandboxSession {
  const results = overrides.runCommandResults ?? {};

  return {
    sandboxId: "test-sandbox",
    sandboxProvider: "e2b",
    homeDir: "/root",
    repoDir: "/root/repo",
    hibernate: vi.fn(),
    runCommand: vi.fn(async (cmd: string) => {
      // Check for matching patterns
      for (const [pattern, result] of Object.entries(results)) {
        if (cmd.includes(pattern)) {
          if (result instanceof Error) throw result;
          return result;
        }
      }
      return "";
    }),
    runBackgroundCommand: vi.fn(),
    shutdown: vi.fn(),
    readTextFile: vi.fn(),
    writeTextFile: vi.fn(),
    writeFile: vi.fn(),
  } as ISandboxSession;
}

describe("runQualityCheckGateInSandbox", () => {
  it("passes when no package.json exists", async () => {
    const session = createMockSession({
      runCommandResults: {
        "test -f package.json": new Error("not found"),
      },
    });

    const result = await runQualityCheckGateInSandbox(session);
    expect(result.gatePassed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("passes when all quality checks succeed", async () => {
    const session = createMockSession({
      runCommandResults: {
        "test -f package.json": "yes",
        "test -d node_modules": "yes",
        "test -f pnpm-lock.yaml": new Error("not found"),
        "test -f bun.lockb": new Error("not found"),
        "test -f bun.lock": new Error("not found"),
        "test -f yarn.lock": new Error("not found"),
        "Object.keys": "lint,typecheck,test",
        "npm run lint": "All good",
        "npm run typecheck": "No errors",
        "npm run test": "Tests passed",
      },
    });

    const result = await runQualityCheckGateInSandbox(session);
    expect(result.gatePassed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when lint fails", async () => {
    const session = createMockSession({
      runCommandResults: {
        "test -f package.json": "yes",
        "test -d node_modules": "yes",
        "test -f pnpm-lock.yaml": new Error("not found"),
        "test -f bun.lockb": new Error("not found"),
        "test -f bun.lock": new Error("not found"),
        "test -f yarn.lock": new Error("not found"),
        "Object.keys": "lint,test",
        "npm run lint": new Error("ESLint: 3 errors"),
        "npm run test": "Tests passed",
      },
    });

    const result = await runQualityCheckGateInSandbox(session);
    expect(result.gatePassed).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(1);
    expect(result.failures[0]).toContain("lint");
  });

  it("detects pnpm from lockfile", async () => {
    const session = createMockSession({
      runCommandResults: {
        "test -f package.json": "yes",
        "test -d node_modules": "yes",
        "test -f pnpm-lock.yaml": "yes",
        "Object.keys": "lint",
        "pnpm run lint": "OK",
      },
    });

    const result = await runQualityCheckGateInSandbox(session);
    expect(result.gatePassed).toBe(true);
    // Verify pnpm was used
    expect(session.runCommand).toHaveBeenCalledWith(
      expect.stringContaining("pnpm run lint"),
      expect.any(Object),
    );
  });

  it("installs deps when node_modules is missing", async () => {
    const session = createMockSession({
      runCommandResults: {
        "test -f package.json": "yes",
        "test -d node_modules": new Error("not found"),
        "test -f pnpm-lock.yaml": new Error("not found"),
        "test -f bun.lockb": new Error("not found"),
        "test -f bun.lock": new Error("not found"),
        "test -f yarn.lock": new Error("not found"),
        "npm install": "installed",
        "Object.keys": "",
      },
    });

    const result = await runQualityCheckGateInSandbox(session);
    expect(result.gatePassed).toBe(true);
    expect(session.runCommand).toHaveBeenCalledWith(
      "npm install",
      expect.any(Object),
    );
  });

  it("fails when dep install fails", async () => {
    const session = createMockSession({
      runCommandResults: {
        "test -f package.json": "yes",
        "test -d node_modules": new Error("not found"),
        "test -f pnpm-lock.yaml": new Error("not found"),
        "test -f bun.lockb": new Error("not found"),
        "test -f bun.lock": new Error("not found"),
        "test -f yarn.lock": new Error("not found"),
        "npm install": new Error("ENOENT"),
      },
    });

    const result = await runQualityCheckGateInSandbox(session);
    expect(result.gatePassed).toBe(false);
    expect(result.failures[0]).toContain("npm install failed");
  });

  it("reports multiple failures", async () => {
    const session = createMockSession({
      runCommandResults: {
        "test -f package.json": "yes",
        "test -d node_modules": "yes",
        "test -f pnpm-lock.yaml": new Error("not found"),
        "test -f bun.lockb": new Error("not found"),
        "test -f bun.lock": new Error("not found"),
        "test -f yarn.lock": new Error("not found"),
        "Object.keys": "lint,typecheck,test",
        "npm run lint": new Error("lint errors"),
        "npm run typecheck": new Error("type errors"),
        "npm run test": new Error("test failures"),
      },
    });

    const result = await runQualityCheckGateInSandbox(session);
    expect(result.gatePassed).toBe(false);
    expect(result.failures.length).toBe(3);
  });
});
