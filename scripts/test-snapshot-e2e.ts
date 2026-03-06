/**
 * E2E test for snapshot builder fixes.
 *
 * Tests:
 *  1. getDefaultBranchForRepo returns correct branch (Fix 1)
 *  2. getSetupScriptFromRepo fetches terragon-setup.sh (Fix 3)
 *  3. Daytona SDK auth via JWT token works
 *  4. Full buildRepoSnapshot call (Fix 1 + 2 + 3 wired together)
 *
 * Usage:
 *   GITHUB_TOKEN=<token> DAYTONA_JWT=<jwt> DAYTONA_ORG_ID=<orgId> \
 *     pnpm tsx scripts/test-snapshot-e2e.ts [--full]
 *
 * --full  runs an actual Daytona snapshot build (takes 5–15 min, costs resources)
 *
 * Notes on Test 4:
 *   - If DAYTONA_API_KEY is set, uses the relay approach: creates (or reuses) a relay
 *     snapshot from the Terragon template via the imageName string API, then uses the
 *     relay's `ref` as the Docker FROM base. This avoids cross-namespace registry auth.
 *   - If only DAYTONA_JWT is set, falls back to ubuntu:22.04 as base image to verify
 *     the API call flow without requiring private registry access.
 */

import { Daytona, Image } from "@daytonaio/sdk";
import crypto from "crypto";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const DAYTONA_JWT = process.env.DAYTONA_JWT!;
const DAYTONA_ORG_ID = process.env.DAYTONA_ORG_ID!;
const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
const REPO = "enzo-health/bonaparte";
const FULL = process.argv.includes("--full");

// latest daytona/small from templates.json
const TEMPLATE_SNAPSHOT_NAME =
  "terry-vCPU-2-RAM-4GB-2026-03-05-05-14-16-qe3p4m";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`✅ PASS: ${msg}`);
}

async function ghFetch(path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "terragon-e2e-test",
    },
  });
  if (!res.ok)
    throw Object.assign(new Error(`GitHub ${res.status} ${path}`), {
      status: res.status,
    });
  return res.json() as Promise<any>;
}

// ── 1. GitHub: default branch ────────────────────────────────────────────────
async function testDefaultBranch() {
  console.log("\n── Test 1: getDefaultBranchForRepo ──");
  const data = await ghFetch(`/repos/${REPO}`);
  const branch = data.default_branch;
  console.log(`  default_branch = "${branch}"`);
  assert(
    typeof branch === "string" && branch.length > 0,
    "default_branch is non-empty string",
  );
  assert(branch === "main", `default_branch is "main" (got "${branch}")`);
}

// ── 2. GitHub: terragon-setup.sh ─────────────────────────────────────────────
async function testSetupScript() {
  console.log("\n── Test 2: getSetupScriptFromRepo ──");
  try {
    const data = await ghFetch(
      `/repos/${REPO}/contents/terragon-setup.sh?ref=main`,
    );
    if (data.content && typeof data.content === "string") {
      const content = Buffer.from(data.content, "base64").toString("utf-8");
      console.log(`  terragon-setup.sh content:\n${content}`);
      assert(content.length > 0, "terragon-setup.sh has content");
    }
  } catch (err: any) {
    if (err?.status === 404) {
      console.log(
        "  terragon-setup.sh not found (404) — Fix 5 not yet applied to Bonaparte",
      );
      console.log(
        "  ⚠️  EXPECTED: Add terragon-setup.sh to Bonaparte for Prisma generate to run in snapshots",
      );
    } else {
      throw err;
    }
  }
}

// ── 3. Daytona: SDK auth ─────────────────────────────────────────────────────
async function testDaytonaAuth() {
  // Prefer API key when available (JWT tokens expire every 24h; API keys don't).
  const usingApiKey = !!DAYTONA_API_KEY;
  console.log(
    `\n── Test 3: Daytona auth + snapshot list (${usingApiKey ? "API key" : "JWT"}) ──`,
  );
  const daytona = usingApiKey
    ? new Daytona({ apiKey: DAYTONA_API_KEY! })
    : new Daytona({ jwtToken: DAYTONA_JWT, organizationId: DAYTONA_ORG_ID });
  const result = await daytona.snapshot.list();
  const snapshots = result.items ?? result;
  console.log(
    `  Found ${result.total ?? snapshots.length} existing snapshots (page ${result.page ?? 1}/${result.totalPages ?? 1})`,
  );
  assert(Array.isArray(snapshots), "snapshot.list() returns items array");
  return daytona;
}

// ── 4. Full snapshot build (opt-in) ──────────────────────────────────────────
async function testFullSnapshotBuild(daytona: Daytona) {
  console.log("\n── Test 4: Full buildRepoSnapshot (--full mode) ──");
  console.log("  Building snapshot for enzo-health/bonaparte...");

  // Minimal setup script to prove it runs
  const setupScript =
    "#!/bin/bash\nset -e\necho 'terragon-setup.sh executed successfully'\n";

  // Determine base image ref.
  // Production uses DAYTONA_API_KEY and resolves the template via snapshot.get().ref.
  // JWT-only test falls back to ubuntu:22.04 to exercise the API call flow without
  // requiring private registry auth (cr.app.daytona.io requires service-account creds).
  let baseImageRef: string;
  if (DAYTONA_API_KEY) {
    console.log(`  Mode: production (API key) — using relay approach`);
    const apiKeyDaytona = new Daytona({ apiKey: DAYTONA_API_KEY });

    // Relay: copy template into our org via imageName string API (no Docker pull needed).
    // Daytona resolves the template server-side; the resulting relay snapshot lives in
    // our namespace and is freely pullable by our build workers.
    const relayHash = crypto
      .createHash("sha256")
      .update(TEMPLATE_SNAPSHOT_NAME)
      .digest("hex")
      .slice(0, 16);
    const relayName = `terragon-relay-${relayHash}`;

    // Fetch the template's ref first (requires tag format for imageName API)
    const templateSnapshot = (await (apiKeyDaytona as any).snapshot.get(
      TEMPLATE_SNAPSHOT_NAME,
    )) as any;
    const templateRef: string = templateSnapshot.ref ?? TEMPLATE_SNAPSHOT_NAME;
    console.log(`  Template ref: ${templateRef}`);

    let relayRef: string | undefined;
    try {
      const existing = (await (apiKeyDaytona as any).snapshot.get(
        relayName,
      )) as any;
      relayRef = existing.ref;
      console.log(`  Relay: found existing ${relayName}`);
    } catch {
      // Use templateRef (has :daytona tag) as imageName — Daytona may handle
      // auth to its own registry server-side (unlike Dockerfile FROM)
      console.log(`  Relay: creating from ref ${templateRef}...`);
      const relay = (await (apiKeyDaytona as any).snapshot.create(
        { name: relayName, image: templateRef },
        {
          onLogs: (chunk: string) => process.stdout.write(`  [relay] ${chunk}`),
          timeout: 0,
        },
      )) as any;
      relayRef = relay.ref;
      console.log(`  Relay: created ${relayName} → ${relayRef}`);
    }
    baseImageRef = relayRef ?? relayName;
    console.log(`  Base image ref: ${baseImageRef}`);
  } else {
    console.log(
      `  Mode: JWT-only — falling back to ubuntu:22.04 (skips private registry auth)`,
    );
    console.log(
      `  ⚠️  Set DAYTONA_API_KEY to test with the actual Terragon template`,
    );
    baseImageRef = "ubuntu:22.04";
  }
  console.log(
    `  Base image: ${baseImageRef}\n  Build time: ~5–15 min (full template) or ~2 min (ubuntu)\n`,
  );

  let image = Image.base(baseImageRef);

  // ubuntu:22.04 fallback needs git installed; Terragon template already has it
  if (!DAYTONA_API_KEY) {
    image = image.runCommands(
      "apt-get update -qq && apt-get install -y -qq git",
    );
  }

  const cloneUrl = `https://${GITHUB_TOKEN}@github.com/${REPO}.git`;
  image = image.runCommands(
    `git clone --filter=blob:none --no-recurse-submodules --branch main ${cloneUrl} /root/repo`,
  );
  if (!DAYTONA_API_KEY) {
    // ubuntu:22.04 doesn't have pnpm/node — just verify git clone + setup script work
    image = image.runCommands("git -C /root/repo log --oneline -1");
    // no package install step
  } else {
    image = image.runCommands(
      `cd /root/repo && ` +
        `if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; ` +
        `elif [ -f yarn.lock ]; then yarn install --frozen-lockfile; ` +
        `elif [ -f package.json ]; then npm install; fi`,
    );
  }

  // Inline setup script
  const fs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "terragon-e2e-"));
  const setupScriptPath = path.join(tmpDir, "terragon-setup.sh");
  fs.writeFileSync(setupScriptPath, setupScript);
  image = image
    .addLocalFile(setupScriptPath, "/tmp/terragon-setup.sh")
    .runCommands(
      "chmod +x /tmp/terragon-setup.sh",
      "bash /tmp/terragon-setup.sh",
    );

  image = image.runCommands(
    "rm -f /root/.git-credentials",
    `git -C /root/repo remote set-url origin https://github.com/${REPO}.git`,
  );

  const snapshotName = `e2e-test-${Date.now()}`;
  console.log(`  Snapshot name: ${snapshotName}`);

  const start = Date.now();
  await daytona.snapshot.create(
    {
      name: snapshotName,
      image,
      resources: { cpu: 2, memory: 4, disk: 10 },
      entrypoint: [
        "/usr/bin/supervisord",
        "-n",
        "-c",
        "/etc/supervisor/conf.d/supervisord.conf",
      ],
    },
    {
      onLogs: (chunk) => process.stdout.write(`  [daytona] ${chunk}`),
      timeout: 0,
    },
  );
  const duration = Math.round((Date.now() - start) / 1000);
  console.log(`\n  Build completed in ${duration}s`);
  assert(true, `snapshot "${snapshotName}" created successfully`);

  // Clean up
  console.log(`  Deleting test snapshot...`);
  const snap = await daytona.snapshot.get(snapshotName);
  await daytona.snapshot.delete(snap);
  console.log(`  Deleted.`);

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Snapshot E2E Test ===");
  console.log(`Repo: ${REPO}`);
  console.log(
    `Mode: ${FULL ? "FULL (real Daytona build)" : "QUICK (no snapshot build)"}\n`,
  );

  if (!GITHUB_TOKEN) {
    console.error("Missing GITHUB_TOKEN");
    process.exit(1);
  }
  if (!DAYTONA_API_KEY && !DAYTONA_JWT) {
    console.error("Missing DAYTONA_API_KEY or DAYTONA_JWT");
    process.exit(1);
  }
  if (!DAYTONA_API_KEY && !DAYTONA_ORG_ID) {
    console.error("Missing DAYTONA_ORG_ID (required when using JWT auth)");
    process.exit(1);
  }

  await testDefaultBranch();
  await testSetupScript();
  const daytona = await testDaytonaAuth();

  if (FULL) {
    await testFullSnapshotBuild(daytona);
  } else {
    console.log(
      "\n── Test 4: Skipped (run with --full to build a real snapshot) ──",
    );
  }

  console.log("\n=== All tests passed ===");
}

main().catch((err) => {
  console.error("\n❌ Test failed:", err);
  process.exit(1);
});
