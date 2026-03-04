import { Daytona, Image } from "@daytonaio/sdk";
import type { Resources } from "@daytonaio/sdk";
import { renderDockerfile } from "@terragon/sandbox-image";
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terragon-snapshot-"));

  try {
    // Render the base Dockerfile for Daytona
    const dockerfileContent = renderDockerfile("daytona");
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(dockerfilePath, dockerfileContent);

    // Build image from base Dockerfile + repo-specific layers
    let image = Image.fromDockerfile(dockerfilePath);

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
      const setupScriptPath = path.join(tmpDir, "terragon-setup.sh");
      fs.writeFileSync(setupScriptPath, setupScript);
      image = image
        .addLocalFile(setupScriptPath, "/tmp/terragon-setup.sh")
        .runCommands(
          "chmod +x /tmp/terragon-setup.sh",
          "cd /root/repo && bash -x /tmp/terragon-setup.sh",
          "rm -f /tmp/terragon-setup.sh",
        );
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
  } finally {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function getSnapshotDockerfileHash(): string {
  const dockerfileHbsPath = path.join(
    require.resolve("@terragon/sandbox-image"),
    "../../Dockerfile.hbs",
  );
  const content = fs.readFileSync(dockerfileHbsPath, "utf-8");
  return crypto.createHash("sha256").update(content).digest("hex");
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
