import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computePreviewValidationRetryScheduleMs,
  redactPreviewValidationLog,
  uiReadyGuardEntrypoints,
} from "./preview-validation";

describe("computePreviewValidationRetryScheduleMs", () => {
  it("applies +20% jitter at the top of the range", () => {
    expect(computePreviewValidationRetryScheduleMs(() => 1)).toEqual([
      0, 144_000, 720_000,
    ]);
  });

  it("applies -20% jitter at the bottom of the range", () => {
    expect(computePreviewValidationRetryScheduleMs(() => 0)).toEqual([
      0, 96_000, 480_000,
    ]);
  });
});

describe("redactPreviewValidationLog", () => {
  it("redacts common credential patterns", () => {
    const input = [
      "Authorization: Bearer abc.123",
      "token=foo123",
      "sk-test-secret-value-abcdef",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
    ].join("\n");

    const output = redactPreviewValidationLog(input);
    expect(output).not.toContain("abc.123");
    expect(output).not.toContain("foo123");
    expect(output).not.toContain("sk-test-secret-value-abcdef");
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });
});

describe("uiReadyGuardEntrypoints", () => {
  it("keeps static guard markers at every ready transition entrypoint", () => {
    for (const entrypoint of uiReadyGuardEntrypoints) {
      const appRelativePath = entrypoint.filePath.replace(/^apps\/www\//, "");
      const candidatePaths = [
        join(process.cwd(), entrypoint.filePath),
        join(process.cwd(), appRelativePath),
      ];
      const fullPath = candidatePaths.find((path) => existsSync(path));
      expect(fullPath).toBeDefined();
      const source = readFileSync(fullPath!, "utf8");
      expect(source).toContain(entrypoint.marker);
    }
  });
});
