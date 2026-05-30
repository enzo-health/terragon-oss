import { Daytona, Image } from "@daytonaio/sdk";
import type { Resources } from "@daytonaio/sdk";
import { renderDockerfile, SUPERVISORD_CONF } from "@terragon/sandbox-image";
import type { SandboxSize } from "@terragon/types/sandbox";
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

// The setup runner: bring up Postgres + Redis, run the repo's setup script, then
// stop the services so they aren't captured mid-write in the snapshot.
function buildSetupRunnerScript(): string {
  return [
    "#!/usr/bin/env bash",
    'PG_CLUSTER_LINE="$(pg_lsclusters --no-header 2>/dev/null | awk \'NF>=2 {print $1" "$2; exit}\')"',
    'if [ -z "$PG_CLUSTER_LINE" ]; then',
    '  PG_CLUSTER_LINE="16 main"',
    "fi",
    'PG_CLUSTER_VERSION="$(echo "$PG_CLUSTER_LINE" | awk \'{print $1}\')"',
    'PG_CLUSTER_NAME="$(echo "$PG_CLUSTER_LINE" | awk \'{print $2}\')"',
    'pg_ctlcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" start',
    "redis-server --bind 127.0.0.1 --daemonize yes",
    "for _ in $(seq 1 30); do",
    "  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break",
    "  sleep 1",
    "done",
    "if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then",
    '  echo "PostgreSQL failed to start"',
    '  pg_ctlcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" stop || true',
    "  redis-cli shutdown || true",
    "  exit 1",
    "fi",
    "for _ in $(seq 1 30); do",
    "  redis-cli ping >/dev/null 2>&1 && break",
    "  sleep 1",
    "done",
    "if ! redis-cli ping >/dev/null 2>&1; then",
    '  echo "Redis failed to start"',
    '  pg_ctlcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" stop || true',
    "  exit 1",
    "fi",
    "cd /root/repo && bash -x /tmp/terragon-setup.sh",
    "EXIT_CODE=$?",
    'pg_ctlcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" stop || true',
    "redis-cli shutdown || true",
    "rm -f /tmp/terragon-setup.sh /tmp/terragon-snapshot-run-setup.sh",
    'exit "$EXIT_CODE"',
  ].join("\n");
}

export async function buildRepoSnapshot({
  repoFullName,
  baseBranch,
  githubAccessToken,
  setupScript,
  environmentVariables,
  size,
  onLogs,
}: {
  repoFullName: string;
  baseBranch: string;
  githubAccessToken: string;
  setupScript: string | null;
  environmentVariables: Array<{ key: string; value: string }>;
  size: SandboxSize;
  onLogs?: (chunk: string) => void;
}): Promise<{ snapshotName: string }> {
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

    if (environmentVariables.length > 0) {
      const envObj: Record<string, string> = {};
      for (const { key, value } of environmentVariables) {
        envObj[key] = value;
      }
      image = image.env(envObj);
    }

    const cloneUrl = `https://${githubAccessToken}@github.com/${repoFullName}.git`;
    image = image.runCommands(
      `git clone --filter=blob:none --no-recurse-submodules --branch ${baseBranch} ${cloneUrl} /root/repo`,
    );

    image = image.runCommands(
      `cd /root/repo && ` +
        `if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; ` +
        `elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; ` +
        `elif [ -f bun.lockb ] || [ -f bun.lock ]; then bun install --frozen-lockfile; ` +
        `elif [ -f package-lock.json ]; then npm ci; ` +
        `elif [ -f package.json ]; then npm install; fi`,
    );

    if (setupScript) {
      const setupScriptPath = path.join(tmpDir, "terragon-setup.sh");
      const setupRunnerPath = path.join(
        tmpDir,
        "terragon-snapshot-run-setup.sh",
      );
      fs.writeFileSync(setupScriptPath, setupScript);
      fs.writeFileSync(setupRunnerPath, buildSetupRunnerScript());
      image = image
        .addLocalFile(setupScriptPath, "/tmp/terragon-setup.sh")
        .addLocalFile(setupRunnerPath, "/tmp/terragon-snapshot-run-setup.sh")
        .runCommands(
          "chmod +x /tmp/terragon-setup.sh /tmp/terragon-snapshot-run-setup.sh",
          "bash /tmp/terragon-snapshot-run-setup.sh",
        );
    }

    image = image.runCommands(
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
      { onLogs, timeout: 0 },
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
