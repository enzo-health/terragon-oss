import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { DBUserMessage } from "@terragon/shared/db/db-message";
import { cliAPIContract } from "@terragon/cli-api-contract";

type CommandName = "help" | "preflight" | "snapshot" | "run" | "e2e";
type RunProfile = "fast" | "full";
type E2EMode = "real" | "dry-run";

type ParsedArgs = {
  command: CommandName;
  profile: RunProfile;
  workflowId: string | null;
  threadId: string | null;
  repo: string | null;
  userId: string | null;
  message: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  webUrl: string | null;
  mode: E2EMode;
  timeoutMs: number;
  pollIntervalMs: number;
};

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/postgres";
const DEFAULT_DEV_CRON_SECRET = "123456";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
let cachedLocalCronSecret: Promise<string | null> | null = null;

function parseArgs(argv: string[]): ParsedArgs {
  let command: CommandName = "help";
  let profile: RunProfile = "fast";
  let workflowId: string | null = null;
  let threadId: string | null = null;
  let repo: string | null = null;
  let userId: string | null = null;
  let message: string | null = null;
  let baseBranch: string | null = null;
  let headBranch: string | null = null;
  let webUrl: string | null = null;
  let mode: E2EMode = "real";
  let timeoutMs = 20 * 60 * 1000;
  let pollIntervalMs = 15_000;

  if (argv.length > 0) {
    const candidate = argv[0];
    if (
      candidate === "help" ||
      candidate === "preflight" ||
      candidate === "snapshot" ||
      candidate === "run" ||
      candidate === "e2e"
    ) {
      command = candidate;
    }
  }

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--profile") {
      const next = argv[i + 1];
      if (next === "fast" || next === "full") {
        profile = next;
        i += 1;
      }
      continue;
    }
    if (arg === "--workflow-id") {
      workflowId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--thread-id") {
      threadId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--repo") {
      repo = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--user-id") {
      userId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--message") {
      message = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--base-branch") {
      baseBranch = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--head-branch") {
      headBranch = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--web-url") {
      webUrl = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const next = argv[i + 1];
      const parsed = next ? Number(next) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        timeoutMs = Math.trunc(parsed);
      }
      i += 1;
      continue;
    }
    if (arg === "--poll-interval-ms") {
      const next = argv[i + 1];
      const parsed = next ? Number(next) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        pollIntervalMs = Math.trunc(parsed);
      }
      i += 1;
      continue;
    }
    if (arg === "--dry-run") {
      mode = "dry-run";
      continue;
    }
  }

  return {
    command,
    profile,
    workflowId,
    threadId,
    repo,
    userId,
    message,
    baseBranch,
    headBranch,
    webUrl,
    mode,
    timeoutMs,
    pollIntervalMs,
  };
}

function usage(): void {
  console.log(`Delivery Loop Local Framework

Usage:
  pnpm delivery-loop:local preflight
  pnpm delivery-loop:local snapshot --workflow-id <id>
  pnpm delivery-loop:local snapshot --thread-id <id>
  pnpm delivery-loop:local run --profile fast
  pnpm delivery-loop:local run --profile full
  pnpm delivery-loop:local e2e --repo <owner/repo> --user-id <id>
  pnpm delivery-loop:local e2e --dry-run --thread-id <id>

Options:
  --profile fast|full     Test suite profile (default: fast)
  --workflow-id <id>      Workflow id for snapshot mode
  --thread-id <id>        Thread id (auto-resolves newest workflow)
  --repo <owner/repo>     Repository for real E2E task creation
  --user-id <id>          User id for real E2E task creation
  --message <text>        Task prompt for real E2E mode
  --base-branch <branch>  Override repo default base branch
  --head-branch <branch>  Override head branch for task creation
  --web-url <url>         App base URL for internal cron nudges
  --dry-run               Inspect an existing workflow/thread only
  --timeout-ms <ms>       Max wait time for real E2E mode
  --poll-interval-ms <ms> Poll interval between cron nudges
`);
}

type SnapshotRow = Record<string, unknown>;

type WorkflowDiagnostics = {
  threadId: string;
  workflowId: string;
  thread: SnapshotRow | null;
  workflow: SnapshotRow | null;
  threadChat: SnapshotRow | null;
  githubPr: SnapshotRow | null;
  workflowEvents: SnapshotRow[];
  signalInbox: SnapshotRow[];
  v3Head: SnapshotRow | null;
  v3Journal: SnapshotRow[];
  v3Effects: SnapshotRow[];
  v3Timers: SnapshotRow[];
  workItems: SnapshotRow[];
};

function getTextValue(row: SnapshotRow | null, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumberValue(row: SnapshotRow | null, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function importLocalModule<T>(relativePath: string): Promise<T> {
  const moduleUrl = pathToFileURL(resolve(REPO_ROOT, relativePath)).href;
  return (await import(moduleUrl)) as T;
}

async function readTerryApiKey(): Promise<string> {
  const settingsDir =
    process.env.TERRY_SETTINGS_DIR?.trim() || `${homedir()}/.terry`;
  const configPath = resolve(settingsDir, "config.json");
  const configText = await readFile(configPath, "utf-8");
  const parsed = JSON.parse(configText) as { apiKey?: unknown };
  const apiKey = parsed.apiKey;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new Error(`No API key found in ${configPath}`);
  }
  return apiKey.trim();
}

async function createCliApiClient(): Promise<{
  client: ContractRouterClient<typeof cliAPIContract>;
}> {
  const webUrl =
    process.env.TERRAGON_WEB_URL ??
    process.env.NEXT_PUBLIC_TERRAGON_WEB_URL ??
    "http://127.0.0.1:3000";
  const apiKey = await readTerryApiKey();
  const link = new RPCLink({
    url: `${webUrl}/api/cli`,
    headers: async () => ({
      "X-Daemon-Token": apiKey,
    }),
  });
  return {
    client: createORPCClient(link) as ContractRouterClient<
      typeof cliAPIContract
    >,
  };
}

async function resolveWorkflowIdByThreadId(
  client: Client,
  threadId: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `select id
       from delivery_workflow
      where thread_id = $1
      order by created_at desc
      limit 1`,
    [threadId],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`No workflow found for thread_id=${threadId}`);
  }
  return id;
}

async function loadWorkflowDiagnostics(params: {
  client: Client;
  threadId: string;
  workflowId: string;
}): Promise<WorkflowDiagnostics> {
  const timerLedgerExistsResult = await params.client.query<{
    exists: string | null;
  }>("select to_regclass('public.delivery_timer_ledger_v3') as exists");
  const timerLedgerExists = Boolean(timerLedgerExistsResult.rows[0]?.exists);
  const legacySignalInboxExistsResult = await params.client.query<{
    exists: string | null;
  }>("select to_regclass('public.sdlc_loop_signal_inbox') as exists");
  const deliverySignalInboxExistsResult = await params.client.query<{
    exists: string | null;
  }>("select to_regclass('public.delivery_signal_inbox') as exists");
  const signalInboxTable = legacySignalInboxExistsResult.rows[0]?.exists
    ? "sdlc_loop_signal_inbox"
    : deliverySignalInboxExistsResult.rows[0]?.exists
      ? "delivery_signal_inbox"
      : null;
  const [
    thread,
    workflow,
    threadChat,
    githubPr,
    workflowEvents,
    signalInbox,
    v3Head,
    v3Journal,
    v3Effects,
    v3Timers,
    workItems,
  ] = await Promise.all([
    params.client.query<SnapshotRow>(
      `select id, status, name, current_branch_name as "branchName",
                repo_base_branch_name as "repoBaseBranchName",
                github_pr_number as "githubPRNumber",
                github_repo_full_name as "githubRepoFullName",
                created_at as "createdAt",
                updated_at as "updatedAt"
           from thread
          where id = $1`,
      [params.threadId],
    ),
    params.client.query<SnapshotRow>(
      `select *
           from delivery_workflow
          where id = $1`,
      [params.workflowId],
    ),
    params.client.query<SnapshotRow>(
      `select id, status, session_id as "sessionId", queued_messages as "queuedMessages",
                schedule_at as "scheduleAt", created_at as "createdAt", updated_at as "updatedAt"
           from thread_chat
          where thread_id = $1
          order by created_at desc
          limit 1`,
      [params.threadId],
    ),
    params.client.query<SnapshotRow>(
      `select id, number, status, base_ref as "baseRef",
                mergeable_state as "mergeableState",
                checks_status as "checksStatus",
                thread_id as "threadId",
                updated_at as "updatedAt"
           from github_pr
          where thread_id = $1
          order by updated_at desc
          limit 5`,
      [params.threadId],
    ),
    params.client.query<SnapshotRow>(
      `select seq, event_kind as "eventKind", state_before as "stateBefore",
                state_after as "stateAfter", gate_before as "gateBefore",
                gate_after as "gateAfter", occurred_at as "occurredAt"
           from delivery_workflow_event
          where workflow_id = $1
          order by seq desc
          limit 20`,
      [params.workflowId],
    ),
    params.client.query<SnapshotRow>(
      signalInboxTable
        ? `select id, cause_type as "causeType",
                  canonical_cause_id as "canonicalCauseId",
                  signal_head_sha_or_null as "signalHeadShaOrNull",
                  processed_at as "processedAt",
                  dead_lettered_at as "deadLetteredAt",
                  dead_letter_reason as "deadLetterReason",
                  processing_attempt_count as "processingAttemptCount",
                  claim_token as "claimToken",
                  claimed_at as "claimedAt",
                  committed_at as "committedAt",
                  received_at as "receivedAt"
             from ${signalInboxTable}
            where loop_id = $1
            order by received_at desc
            limit 20`
        : `select null::text as id where false`,
      signalInboxTable ? [params.workflowId] : [],
    ),
    params.client.query<SnapshotRow>(
      `select workflow_id, thread_id, generation, version, state,
                active_gate as "activeGate",
                head_sha as "headSha",
                active_run_id as "activeRunId",
                fix_attempt_count as "fixAttemptCount",
                infra_retry_count as "infraRetryCount",
                max_fix_attempts as "maxFixAttempts",
                max_infra_retries as "maxInfraRetries",
                blocked_reason as "blockedReason",
                created_at as "createdAt",
                updated_at as "updatedAt",
                last_activity_at as "lastActivityAt"
           from delivery_workflow_head_v3
          where workflow_id = $1`,
      [params.workflowId],
    ),
    params.client.query<SnapshotRow>(
      `select id, source, event_type as "eventType", idempotency_key as "idempotencyKey",
                occurred_at as "occurredAt", created_at as "createdAt"
           from delivery_loop_journal_v3
          where workflow_id = $1
          order by created_at desc
          limit 20`,
      [params.workflowId],
    ),
    params.client.query<SnapshotRow>(
      `select id, workflow_version as "workflowVersion",
                effect_kind as "effectKind", effect_key as "effectKey",
                status,
                due_at as "dueAt", attempt_count as "attemptCount",
                max_attempts as "maxAttempts", last_error_code as "lastErrorCode",
                last_error_message as "lastErrorMessage",
                lease_owner as "leaseOwner", lease_epoch as "leaseEpoch",
                lease_expires_at as "leaseExpiresAt",
                claimed_at as "claimedAt", completed_at as "completedAt",
                created_at as "createdAt"
           from delivery_effect_ledger_v3
          where workflow_id = $1
          order by created_at desc
          limit 20`,
      [params.workflowId],
    ),
    params.client.query<SnapshotRow>(
      timerLedgerExists
        ? `select id, timer_kind as "timerKind", timer_key as "timerKey",
                  idempotency_key as "idempotencyKey", source_signal_id as "sourceSignalId",
                  status, due_at as "dueAt", attempt_count as "attemptCount",
                  max_attempts as "maxAttempts", last_error_code as "lastErrorCode",
                  last_error_message as "lastErrorMessage",
                  lease_owner as "leaseOwner", lease_epoch as "leaseEpoch",
                  lease_expires_at as "leaseExpiresAt",
                  claimed_at as "claimedAt", fired_at as "firedAt",
                  created_at as "createdAt"
             from delivery_timer_ledger_v3
            where workflow_id = $1
            order by created_at desc
            limit 20`
        : `select null::text as id where false`,
      timerLedgerExists ? [params.workflowId] : [],
    ),
    params.client.query<SnapshotRow>(
      `select id, kind, status, attempt_count as "attemptCount",
                scheduled_at as "scheduledAt", claimed_at as "claimedAt",
                completed_at as "completedAt", claim_token as "claimToken",
                last_error_code as "lastErrorCode",
                last_error_message as "lastErrorMessage"
           from delivery_work_item
          where workflow_id = $1
          order by created_at desc
          limit 20`,
      [params.workflowId],
    ),
  ]);

  return {
    threadId: params.threadId,
    workflowId: params.workflowId,
    thread: thread.rows[0] ?? null,
    workflow: workflow.rows[0] ?? null,
    threadChat: threadChat.rows[0] ?? null,
    githubPr: githubPr.rows[0] ?? null,
    workflowEvents: workflowEvents.rows,
    signalInbox: signalInbox.rows,
    v3Head: v3Head.rows[0] ?? null,
    v3Journal: v3Journal.rows,
    v3Effects: v3Effects.rows,
    v3Timers: v3Timers.rows,
    workItems: workItems.rows,
  };
}

async function printDiagnostics(params: {
  client: Client;
  threadId: string;
  workflowId: string;
  label: string;
}): Promise<WorkflowDiagnostics> {
  const diagnostics = await loadWorkflowDiagnostics({
    client: params.client,
    threadId: params.threadId,
    workflowId: params.workflowId,
  });
  console.log(`\n${params.label}`);
  console.log(JSON.stringify(diagnostics, null, 2));
  return diagnostics;
}

function runProcess(cmd: string, args: string[]): void {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env: process.env,
    cwd: REPO_ROOT,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}`);
  }
}

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const connectionString =
    process.env.DELIVERY_LOOP_DATABASE_URL ??
    process.env.DATABASE_URL ??
    DEFAULT_DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function commandPreflight(): Promise<void> {
  await withDb(async (client) => {
    const ping = await client.query<{ ok: number }>("select 1 as ok");
    const v2Table = await client.query<{ exists: string | null }>(
      "select to_regclass('public.delivery_workflow') as exists",
    );
    const v3HeadTable = await client.query<{ exists: string | null }>(
      "select to_regclass('public.delivery_workflow_head_v3') as exists",
    );
    const v3JournalTable = await client.query<{ exists: string | null }>(
      "select to_regclass('public.delivery_loop_journal_v3') as exists",
    );
    const v3EffectsTable = await client.query<{ exists: string | null }>(
      "select to_regclass('public.delivery_effect_ledger_v3') as exists",
    );

    console.log("Preflight checks");
    console.log(`- DB ping: ${ping.rows[0]?.ok === 1 ? "ok" : "failed"}`);
    console.log(
      `- delivery_workflow table: ${v2Table.rows[0]?.exists ? "present" : "missing"}`,
    );
    console.log(
      `- delivery_workflow_head_v3 table: ${v3HeadTable.rows[0]?.exists ? "present" : "missing"}`,
    );
    console.log(
      `- delivery_loop_journal_v3 table: ${v3JournalTable.rows[0]?.exists ? "present" : "missing"}`,
    );
    console.log(
      `- delivery_effect_ledger_v3 table: ${v3EffectsTable.rows[0]?.exists ? "present" : "missing"}`,
    );
  });
}

async function resolveWorkflowId(
  client: Client,
  workflowId: string | null,
  threadId: string | null,
): Promise<string> {
  if (workflowId) {
    return workflowId;
  }
  if (!threadId) {
    throw new Error("snapshot requires --workflow-id or --thread-id");
  }
  const result = await client.query<{ id: string }>(
    `select id
       from delivery_workflow
      where thread_id = $1
      order by created_at desc
      limit 1`,
    [threadId],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error(`No workflow found for thread_id=${threadId}`);
  }
  return id;
}

async function commandSnapshot(args: ParsedArgs): Promise<void> {
  await withDb(async (client) => {
    const workflowId = await resolveWorkflowId(
      client,
      args.workflowId,
      args.threadId,
    );
    let threadId = args.threadId;
    if (!threadId) {
      const threadResult = await client.query<{ thread_id: string }>(
        `select thread_id
           from delivery_workflow
          where id = $1`,
        [workflowId],
      );
      threadId = threadResult.rows[0]?.thread_id ?? "";
    }
    if (!threadId) {
      throw new Error(`No thread found for workflow_id=${workflowId}`);
    }
    const diagnostics = await loadWorkflowDiagnostics({
      client,
      threadId,
      workflowId,
    });
    console.log(JSON.stringify(diagnostics, null, 2));
  });
}

type CronRunResult = {
  status: number;
  text: string;
};

function parseEnvFileValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

async function loadLocalCronSecretFromEnvFiles(): Promise<string | null> {
  const candidatePaths = [
    resolve(REPO_ROOT, "apps/www/.env.development.local"),
    resolve(REPO_ROOT, "apps/www/.env.local"),
    resolve(REPO_ROOT, ".env.development.local"),
    resolve(REPO_ROOT, ".env.local"),
  ];
  for (const candidatePath of candidatePaths) {
    try {
      const content = await readFile(candidatePath, "utf-8");
      const lines = content.split(/\r?\n/);
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) {
          continue;
        }
        if (!trimmedLine.startsWith("CRON_SECRET=")) {
          continue;
        }
        const parsedValue = parseEnvFileValue(
          trimmedLine.slice("CRON_SECRET=".length),
        );
        if (parsedValue.length > 0) {
          return parsedValue;
        }
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
  }
  return null;
}

async function resolveCronSecretForUrl(cronUrl: URL): Promise<string | null> {
  const explicitCronSecret = process.env.CRON_SECRET?.trim();
  if (explicitCronSecret && explicitCronSecret.length > 0) {
    return explicitCronSecret;
  }
  if (!cachedLocalCronSecret) {
    cachedLocalCronSecret = loadLocalCronSecretFromEnvFiles();
  }
  const localEnvCronSecret = await cachedLocalCronSecret;
  if (localEnvCronSecret) {
    return localEnvCronSecret;
  }
  if (cronUrl.hostname === "localhost" || cronUrl.hostname === "127.0.0.1") {
    return DEFAULT_DEV_CRON_SECRET;
  }
  return null;
}

async function triggerScheduledTasksCron(
  webUrl: string,
): Promise<CronRunResult> {
  const cronUrl = new URL("/api/internal/cron/scheduled-tasks", webUrl);
  const headers: HeadersInit = {};
  const cronSecret = await resolveCronSecretForUrl(cronUrl);
  if (cronSecret) {
    headers.authorization = `Bearer ${cronSecret}`;
  }
  const response = await fetch(cronUrl, { method: "GET", headers });
  const text = await response.text();
  return { status: response.status, text };
}

function buildMinimalTaskMessage(message: string): DBUserMessage {
  return {
    type: "user",
    model: "sonnet",
    parts: [{ type: "text", text: message }],
    timestamp: new Date().toISOString(),
  };
}

async function createMinimalTask(params: {
  userId: string;
  repoFullName: string;
  baseBranchName: string | null;
  headBranchName: string | null;
  message: string;
}): Promise<{ threadId: string; branchName: string | null }> {
  const { client: apiClient } = await createCliApiClient();
  return await apiClient.threads.create({
    message: params.message,
    githubRepoFullName: params.repoFullName,
    repoBaseBranchName: params.baseBranchName ?? undefined,
    createNewBranch: true,
    mode: "execute",
  });
}

async function commandE2E(args: ParsedArgs): Promise<void> {
  await withDb(async (client) => {
    const webUrl = args.webUrl ?? process.env.TERRAGON_WEB_URL ?? null;
    if (args.mode !== "dry-run" && !args.repo) {
      throw new Error("e2e real mode requires --repo");
    }
    if (args.mode !== "dry-run" && !args.userId) {
      throw new Error("e2e real mode requires --user-id");
    }
    if (!args.threadId && !args.workflowId && args.mode === "dry-run") {
      throw new Error("dry-run e2e requires --thread-id or --workflow-id");
    }

    if (args.mode === "dry-run") {
      const workflowId = await resolveWorkflowId(
        client,
        args.workflowId,
        args.threadId,
      );
      let threadId = args.threadId;
      if (!threadId) {
        const threadResult = await client.query<{ thread_id: string }>(
          `select thread_id
             from delivery_workflow
            where id = $1`,
          [workflowId],
        );
        threadId = threadResult.rows[0]?.thread_id ?? "";
      }
      if (!threadId) {
        throw new Error(`No thread found for workflow_id=${workflowId}`);
      }
      const diagnostics = await printDiagnostics({
        client,
        threadId,
        workflowId,
        label: "Dry-run diagnostics",
      });
      const githubPrNumber =
        getNumberValue(diagnostics.thread, "githubPRNumber") ??
        getNumberValue(diagnostics.githubPr, "number");
      if (!githubPrNumber) {
        throw new Error(
          `Dry-run did not find a linked PR for thread_id=${threadId}`,
        );
      }
      console.log(
        `Dry-run PR link verified: thread ${threadId} -> PR #${githubPrNumber}`,
      );
      return;
    }

    // Real mode: enforce web URL guard in non-development environments
    if (!webUrl && process.env.NODE_ENV !== "development") {
      throw new Error(
        "e2e real mode requires --web-url or TERRAGON_WEB_URL in non-development environments",
      );
    }

    const resolvedUserId = args.userId ?? "";
    const repoFullName = args.repo ?? "";
    const minimalTaskMessage =
      args.message ??
      "Make the smallest safe change possible and open a PR. Keep the diff tiny and deterministic.";

    const created = await createMinimalTask({
      userId: resolvedUserId,
      repoFullName,
      baseBranchName: args.baseBranch,
      headBranchName: args.headBranch,
      message: minimalTaskMessage,
    });
    console.log("Created task", {
      userId: resolvedUserId,
      repoFullName,
      threadId: created.threadId,
      baseBranchName: args.baseBranch ?? "repo default",
      headBranchName: args.headBranch ?? null,
      branchName: created.branchName,
    });

    const startedAt = Date.now();
    const deadline = startedAt + args.timeoutMs;
    let pollCount = 0;
    let latestWorkflowId: string | null = null;
    let latestDiagnostics: WorkflowDiagnostics | null = null;
    let lastCronStatus: number | null = null;
    let lastCronText: string | null = null;
    const cronBaseUrl =
      webUrl ?? process.env.TERRAGON_WEB_URL ?? "http://127.0.0.1:3000";

    while (Date.now() <= deadline) {
      pollCount += 1;
      const cronResult = await triggerScheduledTasksCron(cronBaseUrl);
      lastCronStatus = cronResult.status;
      lastCronText = cronResult.text;
      if (cronResult.status >= 400) {
        console.warn("Cron nudge returned non-2xx response", {
          status: cronResult.status,
          text: cronResult.text,
        });
      }

      try {
        latestWorkflowId = await resolveWorkflowIdByThreadId(
          client,
          created.threadId,
        );
      } catch {
        latestWorkflowId = null;
      }

      if (latestWorkflowId) {
        latestDiagnostics = await loadWorkflowDiagnostics({
          client,
          threadId: created.threadId,
          workflowId: latestWorkflowId,
        });
        const githubPrNumber =
          getNumberValue(latestDiagnostics.thread, "githubPRNumber") ??
          getNumberValue(latestDiagnostics.githubPr, "number");
        if (githubPrNumber) {
          console.log(
            `E2E PR flow succeeded after ${pollCount} polls in ${Date.now() - startedAt}ms`,
          );
          console.log(
            JSON.stringify(
              {
                threadId: created.threadId,
                workflowId: latestWorkflowId,
                githubPrNumber,
                cron: {
                  lastStatus: lastCronStatus,
                  lastResponse: lastCronText,
                },
              },
              null,
              2,
            ),
          );
          return;
        }

        const workflowKind = getTextValue(latestDiagnostics.workflow, "kind");
        if (
          workflowKind === "done" ||
          workflowKind === "stopped" ||
          workflowKind === "terminated" ||
          workflowKind === "awaiting_operator_action"
        ) {
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
    }

    if (!latestWorkflowId) {
      try {
        latestWorkflowId = await resolveWorkflowIdByThreadId(
          client,
          created.threadId,
        );
        latestDiagnostics = await loadWorkflowDiagnostics({
          client,
          threadId: created.threadId,
          workflowId: latestWorkflowId,
        });
      } catch (error) {
        console.error(
          "Failed to resolve workflow for stuck-state diagnostics",
          {
            threadId: created.threadId,
            error,
          },
        );
      }
    }

    if (latestWorkflowId && latestDiagnostics) {
      await printDiagnostics({
        client,
        threadId: created.threadId,
        workflowId: latestWorkflowId,
        label: "Stuck-state diagnostics",
      });
    }

    throw new Error(
      `Timed out waiting for PR linkage after ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
  });
}

function commandRun(profile: RunProfile): void {
  const fastCommands: Array<{ cmd: string; args: string[] }> = [
    { cmd: "pnpm", args: ["tsc-check"] },
    { cmd: "pnpm", args: ["turbo", "lint"] },
    {
      cmd: "pnpm",
      args: [
        "-C",
        "packages/shared",
        "exec",
        "vitest",
        "run",
        "src/delivery-loop/domain/failure-signature.test.ts",
        "src/delivery-loop/store/dispatch-intent-store.test.ts",
      ],
    },
    {
      cmd: "pnpm",
      args: [
        "-C",
        "apps/www",
        "exec",
        "vitest",
        "run",
        "src/server-lib/delivery-loop/v3/reducer.test.ts",
        "src/server-lib/delivery-loop/v3/process-effects.test.ts",
        "src/app/api/daemon-event/route.test.ts",
      ],
    },
  ];

  const fullCommands: Array<{ cmd: string; args: string[] }> = [
    ...fastCommands,
    {
      cmd: "pnpm",
      args: [
        "-C",
        "apps/www",
        "exec",
        "vitest",
        "run",
        "src/server-lib/delivery-loop/v3/contracts.test.ts",
        "src/server-lib/delivery-loop/v3/invariants.test.ts",
        "src/server-lib/delivery-loop/v3/reachability.test.ts",
        "src/server-lib/delivery-loop/v3/durable-delivery.test.ts",
        "src/app/api/webhooks/github/route.test.ts",
      ],
    },
  ];

  const commands = profile === "full" ? fullCommands : fastCommands;
  for (const command of commands) {
    runProcess(command.cmd, command.args);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "help": {
      usage();
      return;
    }
    case "preflight": {
      await commandPreflight();
      return;
    }
    case "snapshot": {
      await commandSnapshot(args);
      return;
    }
    case "run": {
      commandRun(args.profile);
      return;
    }
    case "e2e": {
      await commandE2E(args);
      return;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
