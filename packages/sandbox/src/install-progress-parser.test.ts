import { describe, it, expect } from "vitest";
import {
  parsePnpmProgressLine,
  InstallProgressSnapshot,
} from "./install-progress-parser";

describe("parsePnpmProgressLine", () => {
  describe("Progress lines", () => {
    it("parses a full progress line with done suffix", () => {
      const result = parsePnpmProgressLine(
        "Progress: resolved 392, reused 147, downloaded 18, added 12, done",
      );
      expect(result).toEqual({
        resolved: 392,
        reused: 147,
        downloaded: 18,
        added: 12,
      });
    });

    it("parses a progress line without done suffix", () => {
      const result = parsePnpmProgressLine(
        "Progress: resolved 392, reused 147, downloaded 18, added 12",
      );
      expect(result).toEqual({
        resolved: 392,
        reused: 147,
        downloaded: 18,
        added: 12,
      });
    });

    it("parses an all-zero progress line (edge case)", () => {
      const result = parsePnpmProgressLine(
        "Progress: resolved 0, reused 0, downloaded 0, added 0, done",
      );
      expect(result).toEqual({
        resolved: 0,
        reused: 0,
        downloaded: 0,
        added: 0,
      });
    });

    it("parses large numbers correctly", () => {
      const result = parsePnpmProgressLine(
        "Progress: resolved 1200, reused 1100, downloaded 50, added 50",
      );
      expect(result).toEqual({
        resolved: 1200,
        reused: 1100,
        downloaded: 50,
        added: 50,
      });
    });

    it("strips ANSI escape codes before matching", () => {
      const line =
        "\x1b[2KProgress: resolved 392, reused 147, downloaded 18, added 12";
      const result = parsePnpmProgressLine(line);
      expect(result).toEqual({
        resolved: 392,
        reused: 147,
        downloaded: 18,
        added: 12,
      });
    });

    it("returns null for a truncated progress line missing fields", () => {
      const result = parsePnpmProgressLine("Progress: resolved 10, reused 5");
      expect(result).toBeNull();
    });
  });

  describe("Scope lines", () => {
    it("parses a scope line", () => {
      const result = parsePnpmProgressLine("Scope: all 47 workspace projects");
      expect(result).toEqual({ total: 47 });
    });

    it("parses a scope line with plural 'projects'", () => {
      const result = parsePnpmProgressLine("Scope: all 1 workspace project");
      expect(result).toEqual({ total: 1 });
    });

    it("returns null for a Scope line that is missing the number", () => {
      const result = parsePnpmProgressLine("Scope: all workspace projects");
      expect(result).toBeNull();
    });
  });

  describe("Per-package install lines", () => {
    it("parses a plain package install line", () => {
      const result = parsePnpmProgressLine(
        ".   node_modules/.pnpm/react@19.1.0/node_modules/react/index.js",
      );
      expect(result).toEqual({ currentPackage: "react" });
    });

    it("parses a scoped package install line (+ encoding)", () => {
      const result = parsePnpmProgressLine(
        ".   node_modules/.pnpm/@scope+pkg@1.2.3/node_modules/@scope/pkg/index.js",
      );
      expect(result).toEqual({ currentPackage: "@scope/pkg" });
    });

    it("parses a line without leading dot", () => {
      const result = parsePnpmProgressLine(
        "   node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/index.js",
      );
      expect(result).toEqual({ currentPackage: "lodash" });
    });

    it("parses a line with leading dot and space", () => {
      const result = parsePnpmProgressLine(
        ". node_modules/.pnpm/typescript@5.0.0/node_modules/typescript/lib/tsc.js",
      );
      expect(result).toEqual({ currentPackage: "typescript" });
    });
  });

  describe("Non-progress lines", () => {
    it("returns null for an empty string", () => {
      expect(parsePnpmProgressLine("")).toBeNull();
    });

    it("returns null for a generic pnpm output line", () => {
      expect(
        parsePnpmProgressLine(
          "Lockfile is up to date, resolution step is skipped",
        ),
      ).toBeNull();
    });

    it("returns null for a warning line", () => {
      expect(
        parsePnpmProgressLine(" WARN  Some deprecation warning"),
      ).toBeNull();
    });

    it("returns null for a git clone output line", () => {
      expect(parsePnpmProgressLine("Cloning into '/root/repo'...")).toBeNull();
    });

    it("returns null for a line with ANSI codes that doesn't match any pattern", () => {
      expect(
        parsePnpmProgressLine("\x1b[32m✓\x1b[0m some other output"),
      ).toBeNull();
    });

    it("returns null for a unicode-heavy line", () => {
      expect(parsePnpmProgressLine("🚀 starting up…")).toBeNull();
    });

    it("does not throw on very long lines", () => {
      const long = "x".repeat(10_000);
      expect(() => parsePnpmProgressLine(long)).not.toThrow();
      expect(parsePnpmProgressLine(long)).toBeNull();
    });

    it("does not throw on binary-like content", () => {
      const binary = "\x00\x01\x02\x03\xFF\xFE";
      expect(() => parsePnpmProgressLine(binary)).not.toThrow();
    });
  });

  describe("Integration: accumulating a sequence of lines", () => {
    it("builds the expected final snapshot from a recorded pnpm session", () => {
      const lines = [
        "Scope: all 47 workspace projects",
        ".   node_modules/.pnpm/typescript@5.0.0/node_modules/typescript/index.js",
        "Progress: resolved 50, reused 30, downloaded 10, added 5",
        ".   node_modules/.pnpm/react@19.1.0/node_modules/react/index.js",
        "Progress: resolved 200, reused 147, downloaded 18, added 12",
        "Some unrelated log line",
        "Progress: resolved 392, reused 147, downloaded 18, added 12, done",
      ];

      const accumulated: InstallProgressSnapshot = {
        resolved: 0,
        reused: 0,
        downloaded: 0,
        added: 0,
      };

      for (const line of lines) {
        const update = parsePnpmProgressLine(line);
        if (!update) continue;
        if (update.resolved !== undefined)
          accumulated.resolved = update.resolved;
        if (update.reused !== undefined) accumulated.reused = update.reused;
        if (update.downloaded !== undefined)
          accumulated.downloaded = update.downloaded;
        if (update.added !== undefined) accumulated.added = update.added;
        if (update.total !== undefined) accumulated.total = update.total;
        if (update.currentPackage !== undefined)
          accumulated.currentPackage = update.currentPackage;
      }

      expect(accumulated).toEqual({
        resolved: 392,
        reused: 147,
        downloaded: 18,
        added: 12,
        total: 47,
        currentPackage: "react",
      });
    });
  });
});
