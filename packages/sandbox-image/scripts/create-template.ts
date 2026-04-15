import type { SandboxProvider, SandboxSize } from "@terragon/types/sandbox";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { renderDockerfile } from "../src/render-dockerfile";

// Parse command line arguments for CPU/memory configuration
const args = process.argv.slice(2);
const sizeArg = args.find((arg) => arg.startsWith("--size="));
const providerArg = args.find((arg) => arg.startsWith("--provider="));
const size = sizeArg?.split("=")[1] as SandboxSize | undefined;
const provider = providerArg?.split("=")[1] as SandboxProvider | undefined;
const templatesJsonPath = path.join(__dirname, "../templates.json");
const dockerfileHbsPath = path.join(__dirname, "../Dockerfile.hbs");
const e2bTomlPath = path.join(__dirname, "../e2b.toml");
const isProd = process.env.NODE_ENV === "production";
const namePrefix = isProd ? "terry" : "terry-dev";

function getDockerfilePath(provider: SandboxProvider): string {
  return path.join(__dirname, `../Dockerfile.${provider}`);
}

type TemplateArgs = {
  cpuCount: number;
  memoryGB: number;
};

function randomSuffix() {
  const dateString = new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/[:T]/g, "-");
  const hex = Math.random().toString(36).substring(2, 8);
  return `${dateString}-${hex}`;
}

function getTemplateName({ cpuCount, memoryGB }: TemplateArgs): string {
  return `${namePrefix}-vCPU-${cpuCount}-RAM-${memoryGB}GB-${randomSuffix()}`;
}

function getDaytonaBuildFlags({ cpuCount, memoryGB }: TemplateArgs) {
  const name = getTemplateName({ cpuCount, memoryGB });
  const dockerfilePath = getDockerfilePath("daytona");
  return {
    name,
    args: [
      name,
      "-f",
      path.relative(process.cwd(), dockerfilePath),
      "--cpu",
      cpuCount.toString(),
      "--disk",
      "10",
      "--memory",
      memoryGB.toString(),
    ],
  };
}

function getE2BBuildFlags({ cpuCount, memoryGB }: TemplateArgs) {
  const name = getTemplateName({ cpuCount, memoryGB });
  const dockerfilePath = getDockerfilePath("e2b");
  const memoryMB = memoryGB * 1024;
  return {
    name,
    args: [
      "--name",
      name,
      "--dockerfile",
      path.relative(process.cwd(), dockerfilePath),
      "--cpu-count",
      cpuCount.toString(),
      "--memory-mb",
      memoryMB.toString(),
    ],
  };
}

function runCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`Running command: ${command}`);
    const child = spawn(command, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: true,
    });
    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });
    child.on("error", (error: Error) => {
      reject(error);
    });
  });
}

function runCommandCapture(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      stdio: ["inherit", "pipe", "pipe"],
      shell: true,
    });
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(d);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Command failed (${code}): ${command}`));
    });
    child.on("error", reject);
  });
}

/**
 * Assert the Daytona CLI's active organization is the one prod actually uses.
 *
 * Three prior prod outages (#129 bcogzd, #136 nhrope/3ldxcp) shipped snapshots
 * into an Enzo-org namespace that prod's Personal-org API key couldn't see.
 * `daytona snapshot list` happily reported them as "registered" in Enzo, so
 * the post-create verification at `verifyDaytonaSnapshotRegistered` passed
 * while prod remained broken.
 *
 * Fix: read the CLI's currently-active org and fail loudly if it doesn't
 * match the ID in `DAYTONA_PROD_ORG_ID`. The intent is to make it impossible
 * to publish a Daytona snapshot to the wrong namespace.
 *
 * The env var is required only for `create-template.ts`; other tests and
 * scripts don't set it and aren't affected.
 */
async function assertActiveDaytonaOrg(): Promise<void> {
  const expectedId = process.env.DAYTONA_PROD_ORG_ID?.trim();
  if (!expectedId) {
    throw new Error(
      "DAYTONA_PROD_ORG_ID is not set. Export the org id that prod's " +
        "DAYTONA_API_KEY is scoped to before running create-template. " +
        "Example: export DAYTONA_PROD_ORG_ID=f9c41839-9458-4a4b-b51d-f54d63236df5",
    );
  }
  const output = await runCommandCapture("daytona organization list");
  // Format: `[[Name id last-seen] [*ActiveName id last-seen]]`. Parse the
  // starred line to find the active org id.
  const activeMatch = output.match(/\*([^\s\]]+)\s+([0-9a-f-]{36})/);
  if (!activeMatch) {
    throw new Error(
      "Could not determine active Daytona organization. Is the CLI " +
        "authenticated? Run: daytona login",
    );
  }
  const [, activeName, activeId] = activeMatch;
  if (activeId !== expectedId) {
    throw new Error(
      `Refusing to build: Daytona CLI is in org "${activeName}" (${activeId}) ` +
        `but prod expects ${expectedId}. Fix with:\n` +
        `  daytona organization use ${expectedId}\n` +
        `Then re-run.`,
    );
  }
  console.log(
    `Verified Daytona CLI is in the prod org "${activeName}" (${activeId}).`,
  );
}

async function verifyDaytonaSnapshotRegistered(name: string): Promise<void> {
  // Previous silent registration failures left templates.json pointing at
  // ghost snapshots (see hotfix PR #129). Confirm the name is queryable
  // before we let the caller persist the entry.
  console.log(`Verifying Daytona snapshot "${name}" is registered...`);
  const output = await runCommandCapture(`daytona snapshot list`);
  if (!output.includes(name)) {
    throw new Error(
      `Daytona snapshot "${name}" did not appear in 'daytona snapshot list' after create. ` +
        `Refusing to update templates.json — registration likely failed silently.`,
    );
  }
  console.log(`Verified: "${name}" is registered in Daytona.`);
}

function getDockerfileHash(): string {
  const dockerfileHbsContent = fs.readFileSync(dockerfileHbsPath, "utf-8");
  return crypto.createHash("sha256").update(dockerfileHbsContent).digest("hex");
}

async function buildE2BTemplate(templateArgs: TemplateArgs) {
  // Render the Dockerfile for e2b
  const dockerfileContent = renderDockerfile("e2b");
  const dockerfilePath = getDockerfilePath("e2b");
  fs.writeFileSync(dockerfilePath, dockerfileContent);

  // Delete e2b.toml if it exists
  if (fs.existsSync(e2bTomlPath)) {
    console.log(`Deleting existing e2b.toml at ${e2bTomlPath}`);
    fs.unlinkSync(e2bTomlPath);
  }
  const { name, args } = getE2BBuildFlags(templateArgs);
  await runCommand(`e2b template build ${args.join(" ")}`);
  console.log(`Template built successfully: ${name}`);
  return name;
}

async function buildDaytonaTemplate(templateArgs: TemplateArgs) {
  // Pre-flight: assert the CLI is in the prod org before we push ANYTHING.
  // If this fails, nothing is built or uploaded — cheapest possible guard.
  await assertActiveDaytonaOrg();

  // Render the Dockerfile for daytona
  const dockerfileContent = renderDockerfile("daytona");
  const dockerfilePath = getDockerfilePath("daytona");
  fs.writeFileSync(dockerfilePath, dockerfileContent);

  const { name, args } = getDaytonaBuildFlags(templateArgs);
  await runCommand(`daytona snapshot create ${args.join(" ")}`);
  await verifyDaytonaSnapshotRegistered(name);
  console.log(`Template built successfully: ${name}`);
  return name;
}

async function updateTemplatesJson({
  templateName,
  dockerfileHash,
  cpuCount,
  memoryGB,
  provider,
  size,
}: {
  templateName: string;
  dockerfileHash: string;
  cpuCount: number;
  memoryGB: number;
  provider: SandboxProvider;
  size: SandboxSize;
}) {
  let templates: any[] = [];
  if (fs.existsSync(templatesJsonPath)) {
    const content = fs.readFileSync(templatesJsonPath, "utf-8");
    templates = JSON.parse(content);
  }
  // Add or update the template entry
  templates.push({
    name: templateName,
    dockerfileHash,
    cpuCount,
    memoryGB,
    provider,
    size,
    createdAt: new Date().toISOString(),
  });
  fs.writeFileSync(templatesJsonPath, JSON.stringify(templates, null, 2));
}

async function main() {
  if (!size) {
    throw new Error("Size is required");
  }
  if (!provider) {
    throw new Error("Provider is required");
  }
  // Default to 2vCPU/4GB if not specified
  const cpuCount = size === "large" ? 4 : 2;
  const memoryGB = size === "large" ? 8 : 4;
  const dockerfileHash = getDockerfileHash();
  console.log(`Creating ${provider} template for ${size} size...`);
  console.log(` * CPU: ${cpuCount} vCPU`);
  console.log(` * Memory: ${memoryGB}GB`);
  console.log(` * Dockerfile hash: ${dockerfileHash}`);

  const startTime = Date.now();
  let templateName: string;
  const templateArgs: TemplateArgs = { cpuCount, memoryGB };
  switch (provider) {
    case "e2b": {
      templateName = await buildE2BTemplate(templateArgs);
      break;
    }
    case "daytona":
      templateName = await buildDaytonaTemplate(templateArgs);
      break;
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
  await updateTemplatesJson({
    templateName,
    dockerfileHash,
    cpuCount,
    memoryGB,
    provider,
    size,
  });
  console.log(`Successfully created template: ${templateName}`, {
    cpuCount,
    memoryGB,
    dockerfileHash,
    provider,
    size,
    durationMs: Date.now() - startTime,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
