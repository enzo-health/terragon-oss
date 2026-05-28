#!/usr/bin/env bun
/**
 * Updates packages/sandbox-image/Dockerfile to the latest npm versions of:
 * - @anthropic-ai/claude-code
 * - @openai/codex
 *
 * Fetches versions using `npm view <pkg> version --json`.
 * Run with: bun packages/sandbox-image/scripts/update-dockerfile-versions.ts [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DRY_RUN = process.argv.includes("--dry-run");

type Pkg = {
  name: string;
  regex: RegExp; // pattern to replace in Dockerfile
};

const PACKAGES: Pkg[] = [
  {
    name: "@anthropic-ai/claude-code",
    // Matches @anthropic-ai/claude-code@<semver>
    regex: /@anthropic-ai\/claude-code@([0-9]+\.[0-9]+\.[0-9]+)/g,
  },
  {
    name: "@openai/codex",
    // Matches @openai/codex@<semver>
    regex: /@openai\/codex@([0-9]+\.[0-9]+\.[0-9]+)/g,
  },
];

function getLatestVersionViaNpm(pkgName: string): string {
  const res = spawnSync("npm", ["view", pkgName, "version", "--json"], {
    encoding: "utf8",
  });
  if (res.error) {
    throw new Error(
      `Failed to run npm view for ${pkgName}: ${res.error.message}`,
    );
  }
  if (res.status !== 0) {
    throw new Error(
      `npm view for ${pkgName} failed with code ${res.status}: ${res.stderr || res.stdout}`,
    );
  }

  const raw = (res.stdout || "").trim();
  // npm --json may return a string or an array; handle both
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (Array.isArray(parsed)) return parsed[parsed.length - 1];
  } catch {
    // Fallback if output wasn't JSON (shouldn't happen with --json)
    if (/^\d+\.\d+\.\d+/.test(raw)) return raw.match(/\d+\.\d+\.\d+/)![0];
  }
  throw new Error(`Could not parse version from npm for ${pkgName}: ${raw}`);
}

function updateDockerfile(
  dockerfilePath: string,
  versions: Record<string, string>,
): {
  updated: boolean;
  before: string;
  after: string;
  changes: Array<{
    name: string;
    from?: string;
    to: string;
    occurrences: number;
  }>;
} {
  const before = readFileSync(dockerfilePath, "utf8");
  let after = before;
  const changes: Array<{
    name: string;
    from?: string;
    to: string;
    occurrences: number;
  }> = [];

  for (const { name, regex } of PACKAGES) {
    const latest = versions[name];
    if (!latest) continue;

    let occurrences = 0;
    let lastMatchFrom: string | undefined;
    after = after.replace(regex, (match, current) => {
      occurrences++;
      lastMatchFrom = current;
      return match.replace(current, latest);
    });
    if (occurrences > 0) {
      changes.push({ name, from: lastMatchFrom, to: latest, occurrences });
    } else {
      // Nothing matched; still record an attempted change for visibility
      changes.push({ name, to: latest, occurrences: 0 });
    }
  }

  return { updated: before !== after, before, after, changes };
}

async function main() {
  const pkgVersions: Record<string, string> = {};

  for (const { name } of PACKAGES) {
    const version = getLatestVersionViaNpm(name);
    pkgVersions[name] = version;
  }

  const dockerfileHbsPath = join(__dirname, "..", "Dockerfile.hbs");
  const {
    updated: dockerUpdated,
    before,
    after,
    changes,
  } = updateDockerfile(dockerfileHbsPath, pkgVersions);

  // Log Dockerfile summary
  for (const c of changes) {
    if (c.occurrences === 0) {
      console.warn(
        `Warning: No occurrences found for ${c.name} in Dockerfile.`,
      );
    } else if (c.from === c.to) {
      console.log(
        `${c.name} already up-to-date at ${c.to} (found ${c.occurrences}).`,
      );
    } else {
      console.log(
        `${c.name}: ${c.from ?? "unknown"} -> ${c.to} (updated ${c.occurrences}).`,
      );
    }
  }

  // Prepare test updates (currently only claude --version inline snapshot)
  const templateTestPath = join(__dirname, "..", "template.test.ts");
  const testExists = existsSync(templateTestPath);
  const beforeTest = testExists ? readFileSync(templateTestPath, "utf8") : "";
  let afterTest = beforeTest;
  let testUpdated = false;
  if (testExists) {
    const claudeVersion = pkgVersions["@anthropic-ai/claude-code"];
    if (claudeVersion) {
      // Replace inline snapshot: "<semver> (Claude Code)"
      const re =
        /toMatchInlineSnapshot\(\s*`"(\d+\.\d+\.\d+) \(Claude Code\)"`\s*\)/g;
      afterTest = afterTest.replace(re, (_m, _current) => {
        return (
          `toMatchInlineSnapshot(` +
          '`"' +
          claudeVersion +
          ' (Claude Code)"`' +
          ")"
        );
      });
    }
    testUpdated = afterTest !== beforeTest;
  }

  if (DRY_RUN) {
    if (dockerUpdated) {
      console.log("--dry-run: Dockerfile.hbs changes\n");
      const beforeLines = before.split(/\r?\n/);
      const afterLines = after.split(/\r?\n/);
      const max = Math.max(beforeLines.length, afterLines.length);
      for (let i = 0; i < max; i++) {
        const a = beforeLines[i];
        const b = afterLines[i];
        if (a !== b) {
          console.log(`- ${a ?? ""}`);
          console.log(`+ ${b ?? ""}`);
        }
      }
    } else {
      console.log("Dockerfile.hbs already up-to-date. No changes.");
    }
    if (testExists) {
      if (testUpdated) {
        console.log("\n--dry-run: template.test.ts changes\n");
        const beforeLines = beforeTest.split(/\r?\n/);
        const afterLines = afterTest.split(/\r?\n/);
        const max = Math.max(beforeLines.length, afterLines.length);
        for (let i = 0; i < max; i++) {
          const a = beforeLines[i];
          const b = afterLines[i];
          if (a !== b) {
            console.log(`- ${a ?? ""}`);
            console.log(`+ ${b ?? ""}`);
          }
        }
      } else {
        console.log("No test updates needed in template.test.ts");
      }
    }
    return;
  }

  if (dockerUpdated) {
    writeFileSync(dockerfileHbsPath, after, "utf8");
    console.log(`Updated ${dockerfileHbsPath}`);
  } else {
    console.log("Dockerfile.hbs already up-to-date.");
  }

  if (testExists) {
    if (testUpdated) {
      writeFileSync(templateTestPath, afterTest, "utf8");
      console.log(
        `Updated ${templateTestPath} inline snapshots for Claude Code.`,
      );
    } else {
      console.log(`No test updates needed in ${templateTestPath}.`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
