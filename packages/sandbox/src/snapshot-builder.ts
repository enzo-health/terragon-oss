import { Daytona, Image } from "@daytonaio/sdk";
import type { Resources } from "@daytonaio/sdk";
import { getTemplateIdForSize } from "@leo/sandbox-image";
import type { SandboxSize } from "@leo/types/sandbox";
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

  // Start from the pre-built Daytona base template (already has Node, tools, etc.)
  const baseTemplateId = getTemplateIdForSize({
    provider: "daytona",
    size,
  });
  // Use the snapshot's `ref` (a Daytona container-registry URI) as the FROM base.
  // Template names like "terry-vCPU-2-RAM-4GB-..." contain uppercase letters which
  // Docker rejects in FROM directives; the `ref` is always a lowercase SHA digest URI.
  // NOTE: pulling from cr.app.daytona.io/sbox/ requires Daytona build workers to have
  // registry credentials. This works with a service-account API key; personal API keys
  // may fail with "unauthorized". Contact Daytona support if builds fail here.
  const templateSnapshot = (await daytona.snapshot.get(baseTemplateId)) as any;
  const baseImageRef: string = templateSnapshot.ref ?? baseTemplateId;
  let image = Image.base(baseImageRef);

  // Set environment variables for build
  if (environmentVariables.length > 0) {
    const envObj: Record<string, string> = {};
    for (const { key, value } of environmentVariables) {
      envObj[key] = value;
    }
    image = image.env(envObj);
  }

  // Clone the repo (filter=blob:none for faster partial clone)
  const cloneUrl = `https://${githubAccessToken}@github.com/${repoFullName}.git`;
  image = image.runCommands(
    `git clone --filter=blob:none --no-recurse-submodules --branch ${baseBranch} ${cloneUrl} /root/repo`,
  );

  // Detect package manager and install deps
  image = image.runCommands(
    `cd /root/repo && ` +
      `if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; ` +
      `elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; ` +
      `elif [ -f bun.lockb ] || [ -f bun.lock ]; then bun install --frozen-lockfile; ` +
      `elif [ -f package-lock.json ]; then npm ci; ` +
      `elif [ -f package.json ]; then npm install; fi`,
  );

  // Run setup script if provided
  if (setupScript) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "leo-snapshot-"));
    try {
      const setupScriptPath = path.join(tmpDir, "leo-setup.sh");
      const setupRunnerPath = path.join(tmpDir, "leo-snapshot-run-setup.sh");
      fs.writeFileSync(setupScriptPath, setupScript);
      const setupCommand = [
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
        "cd /root/repo && bash -x /tmp/leo-setup.sh",
        "EXIT_CODE=$?",
        'pg_ctlcluster "$PG_CLUSTER_VERSION" "$PG_CLUSTER_NAME" stop || true',
        "redis-cli shutdown || true",
        "rm -f /tmp/leo-setup.sh /tmp/leo-snapshot-run-setup.sh",
        'exit "$EXIT_CODE"',
      ].join("\n");
      fs.writeFileSync(setupRunnerPath, setupCommand);
      image = image
        .addLocalFile(setupScriptPath, "/tmp/leo-setup.sh")
        .addLocalFile(setupRunnerPath, "/tmp/leo-snapshot-run-setup.sh")
        .runCommands(
          "chmod +x /tmp/leo-setup.sh /tmp/leo-snapshot-run-setup.sh",
          // Start services, run setup, stop services — all in one RUN layer
          "bash /tmp/leo-snapshot-run-setup.sh",
        );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // Clean up credentials from the image
  image = image.runCommands(
    "rm -f /root/.git-credentials",
    `git -C /root/repo remote set-url origin https://github.com/${repoFullName}.git`,
  );

  // Create the snapshot
  const snapshotName = `repo-${repoFullName.replace("/", "-").toLowerCase()}-${size}-${Date.now()}`;
  const resources = RESOURCE_MAP[size];

  await daytona.snapshot.create(
    {
      name: snapshotName,
      image,
      resources,
      entrypoint: [
        "/usr/bin/supervisord",
        "-n",
        "-c",
        "/etc/supervisor/conf.d/supervisord.conf",
      ],
    },
    { onLogs, timeout: 0 },
  );

  return { snapshotName };
}

export function getSnapshotBaseTemplateId(size: SandboxSize): string {
  return getTemplateIdForSize({ provider: "daytona", size });
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
