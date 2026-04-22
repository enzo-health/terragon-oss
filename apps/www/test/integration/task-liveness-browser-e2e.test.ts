import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs, writeFailureArtifacts } from "./task-liveness-browser-e2e";

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("task-liveness-browser-e2e capture behavior", () => {
  it("defaults to temp artifacts dir and no fixture capture path", () => {
    const options = parseArgs([]);

    expect(options.artifactsDir).toBe(
      path.resolve(os.tmpdir(), "terragon-task-liveness-artifacts"),
    );
    expect(options.captureFixturePath).toBeNull();
  });

  it("accepts explicit fixture capture path opt-in", () => {
    const options = parseArgs([
      "--capture-fixture-path",
      "./recordings/captures/task-liveness-latest.jsonl",
    ]);

    expect(options.captureFixturePath).toBe(
      path.resolve("./recordings/captures/task-liveness-latest.jsonl"),
    );
  });

  it("does not write tracked fixture when capture path is unset", async () => {
    const artifactsDir = await createTempDir("task-liveness-artifacts-");
    const fixturePath = path.join(
      artifactsDir,
      "recordings/captures/task-liveness-latest.jsonl",
    );

    await writeFailureArtifacts({
      artifactsDir,
      screenshotPng: null,
      scenario: null,
      debugPayload: null,
      replayRecordingJsonl: '{"event":"x"}\n',
      failureMessage: "boom",
      captureFixturePath: null,
      failureStep: "seed_scenario",
      baseUrl: "http://localhost:3000",
    });

    expect(await pathExists(fixturePath)).toBe(false);
  });

  it("writes fixture only when explicit capture path is provided", async () => {
    const artifactsDir = await createTempDir("task-liveness-artifacts-");
    const fixturePath = path.join(
      artifactsDir,
      "recordings/captures/task-liveness-latest.jsonl",
    );

    await writeFailureArtifacts({
      artifactsDir,
      screenshotPng: null,
      scenario: null,
      debugPayload: null,
      replayRecordingJsonl: '{"event":"x"}\n',
      failureMessage: "boom",
      captureFixturePath: fixturePath,
      failureStep: "seed_scenario",
      baseUrl: "http://localhost:3000",
    });

    expect(await pathExists(fixturePath)).toBe(true);
    await expect(fs.readFile(fixturePath, "utf8")).resolves.toBe(
      '{"event":"x"}\n',
    );
  });
});
