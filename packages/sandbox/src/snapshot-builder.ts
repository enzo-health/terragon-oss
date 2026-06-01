import { Daytona, Image } from "@daytonaio/sdk";
import type { Resources } from "@daytonaio/sdk";
import { renderDockerfile, SUPERVISORD_CONF } from "@terragon/sandbox-image";
import type { SandboxSize } from "@terragon/types/sandbox";
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";

const RESOURCE_MAP: Record<SandboxSize, Resources> = {
  small: { cpu: 2, memory: 4, disk: 10 },
  large: { cpu: 4, memory: 8, disk: 10 },
};

function getDaytonaClient(): Daytona {
  const apiKey = process.env.DAYTONA_API_KEY;
  if (!apiKey) throw new Error("DAYTONA_API_KEY is not set");
  return new Daytona({ apiKey });
}

export function getUnsafeRepoSnapshotInputReasons({
  setupScript,
  environmentVariables,
  mcpConfig,
}: {
  setupScript: string | null;
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig?: unknown;
}): string[] {
  const reasons: string[] = [];
  if (setupScript?.trim()) {
    reasons.push("setup-script");
  }
  if (environmentVariables.length > 0) {
    reasons.push("environment-variables");
  }
  if (hasSnapshotMcpConfig(mcpConfig)) {
    reasons.push("mcp-config");
  }
  return reasons;
}

export function isRepoSnapshotBuildSafe(
  input: Parameters<typeof getUnsafeRepoSnapshotInputReasons>[0],
): boolean {
  return getUnsafeRepoSnapshotInputReasons(input).length === 0;
}

function hasSnapshotMcpConfig(mcpConfig: unknown): boolean {
  if (mcpConfig === null || mcpConfig === undefined) {
    return false;
  }
  if (Array.isArray(mcpConfig)) {
    return mcpConfig.length > 0;
  }
  if (typeof mcpConfig === "object") {
    return Object.keys(mcpConfig).length > 0;
  }
  return true;
}

function assertRepoSnapshotBuildSafe(
  input: Parameters<typeof getUnsafeRepoSnapshotInputReasons>[0],
): void {
  const reasons = getUnsafeRepoSnapshotInputReasons(input);
  if (reasons.length === 0) {
    return;
  }
  throw new Error(
    `Repo snapshot build disabled for unsafe inputs: ${reasons.join(", ")}`,
  );
}

function redactSnapshotLogChunk(chunk: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce(
      (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
      chunk,
    );
}

function buildSnapshotPruneCommand(): string {
  return [
    "rm -rf",
    "/root/repo/.next",
    "/root/repo/.turbo",
    "/root/repo/node_modules/.cache",
    "/root/.cache/ms-playwright",
    "/root/.cache/puppeteer",
    "/root/.cache/Cypress",
    "/tmp/*",
  ].join(" ");
}

function cloneRepoIntoBuildContext({
  repoFullName,
  baseBranch,
  githubAccessToken,
  tmpDir,
}: {
  repoFullName: string;
  baseBranch: string;
  githubAccessToken: string;
  tmpDir: string;
}): string {
  const repoPath = path.join(tmpDir, "repo");
  const askpassPath = path.join(tmpDir, "git-askpass.sh");
  fs.writeFileSync(
    askpassPath,
    [
      "#!/bin/sh",
      'case "$1" in',
      '*Username*) printf "%s\\n" "x-access-token" ;;',
      '*) printf "%s\\n" "$GITHUB_ACCESS_TOKEN" ;;',
      "esac",
    ].join("\n"),
    { mode: 0o700 },
  );

  execFileSync(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-recurse-submodules",
      "--branch",
      baseBranch,
      `https://github.com/${repoFullName}.git`,
      repoPath,
    ],
    {
      env: {
        ...process.env,
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
        GITHUB_ACCESS_TOKEN: githubAccessToken,
      },
      stdio: "pipe",
    },
  );
  execFileSync(
    "git",
    [
      "-C",
      repoPath,
      "remote",
      "set-url",
      "origin",
      `https://github.com/${repoFullName}.git`,
    ],
    { stdio: "pipe" },
  );
  return repoPath;
}

export async function buildRepoSnapshot({
  repoFullName,
  baseBranch,
  githubAccessToken,
  setupScript,
  environmentVariables,
  mcpConfig,
  size,
  onLogs,
}: {
  repoFullName: string;
  baseBranch: string;
  githubAccessToken: string;
  setupScript: string | null;
  environmentVariables: Array<{ key: string; value: string }>;
  mcpConfig?: unknown;
  size: SandboxSize;
  onLogs?: (chunk: string) => void;
}): Promise<{ snapshotName: string }> {
  assertRepoSnapshotBuildSafe({ setupScript, environmentVariables, mcpConfig });
  const daytona = getDaytonaClient();

  // Build the toolchain base FROM ubuntu via the maintained Dockerfile, then layer
  // the repo on top — all in one build from a public registry. Building `FROM` the
  // pre-baked Daytona template ref is not possible: cr.app.daytona.io/sbox returns
  // 401 to build workers (no pull creds), and Daytona doesn't support chaining a
  // build on another snapshot. ubuntu:24.04 pulls from public Docker Hub, so the
  // repo snapshot is rebuilt from scratch each time but stays private to the org.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terragon-snapshot-"));
  try {
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(dockerfilePath, renderDockerfile("daytona"));
    // The daytona Dockerfile `COPY`s supervisord.conf from the build context.
    fs.writeFileSync(path.join(tmpDir, "supervisord.conf"), SUPERVISORD_CONF);

    let image = Image.fromDockerfile(dockerfilePath);
    const repoPath = cloneRepoIntoBuildContext({
      repoFullName,
      baseBranch,
      githubAccessToken,
      tmpDir,
    });

    image = image.addLocalDir(repoPath, "/root/repo");

    image = image.runCommands(
      `cd /root/repo && ` +
        `if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; ` +
        `elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; ` +
        `elif [ -f bun.lockb ] || [ -f bun.lock ]; then bun install --frozen-lockfile; ` +
        `elif [ -f package-lock.json ]; then npm ci; ` +
        `elif [ -f package.json ]; then npm install; fi`,
    );

    image = image.runCommands(
      buildSnapshotPruneCommand(),
      "rm -f /root/.git-credentials",
      `git -C /root/repo remote set-url origin https://github.com/${repoFullName}.git`,
    );

    const snapshotName = `repo-${repoFullName.replace("/", "-").toLowerCase()}-${size}-${Date.now()}`;

    await daytona.snapshot.create(
      {
        name: snapshotName,
        image,
        resources: RESOURCE_MAP[size],
        // Daytona doesn't reliably inherit the base image's ENTRYPOINT for
        // declarative snapshots, so set it explicitly to the Dockerfile's wrapper.
        entrypoint: ["/entrypoint.sh"],
      },
      {
        onLogs: onLogs
          ? (chunk) =>
              onLogs(
                redactSnapshotLogChunk(chunk, [
                  githubAccessToken,
                  ...environmentVariables.map((entry) => entry.value),
                  setupScript ?? "",
                ]),
              )
          : undefined,
        timeout: 0,
      },
    );

    return { snapshotName };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Identifies the base image definition so `baseDockerfileHash` invalidates
// snapshots when the toolchain Dockerfile changes.
export function getSnapshotBaseTemplateId(_size: SandboxSize): string {
  return crypto
    .createHash("sha256")
    .update(renderDockerfile("daytona"))
    .digest("hex");
}

export function getSetupScriptHash(script: string | null): string {
  if (!script) return "";
  return crypto.createHash("sha256").update(script).digest("hex");
}

export async function deleteRepoSnapshot(snapshotName: string): Promise<void> {
  const daytona = getDaytonaClient();
  const snapshot = await daytona.snapshot.get(snapshotName);
  await daytona.snapshot.delete(snapshot);
}

// All per-repo snapshot names (the `repo-…` prefix that `buildRepoSnapshot`
// assigns). Used by the orphan reaper to find Daytona snapshots no DB entry
// references. Reads the first page only — `snapshot.list()` paginates, so a
// very large account may need multiple passes across cron runs to fully drain.
export async function listRepoSnapshotNames(): Promise<string[]> {
  const daytona = getDaytonaClient();
  const result = (await daytona.snapshot.list()) as
    | { items?: Array<{ name?: string | null }> }
    | Array<{ name?: string | null }>;
  const items = Array.isArray(result) ? result : (result.items ?? []);
  return items
    .map((snapshot) => snapshot.name ?? "")
    .filter((name) => name.startsWith("repo-"));
}
