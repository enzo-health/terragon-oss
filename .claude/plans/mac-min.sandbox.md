# Plan: OpenSandbox on Mac Mini Fleet for Terragon

## Context

Terragon currently uses Daytona (and historically E2B) for remote sandboxes, but they lack power. With ~10 Mac Minis available, we want to use Alibaba's [OpenSandbox](https://github.com/alibaba/OpenSandbox) (Apache 2.0, released March 2026) as a self-hosted sandbox runtime on these machines. OpenSandbox provides a lifecycle server + Docker runtime + multi-language SDKs -- a clean fit for Terragon's existing `ISandboxProvider` abstraction.

## What Runs on Each Mac Mini

Each Mac Mini becomes a sandbox worker node running:

1. **Docker** (Docker Desktop or OrbStack for better perf on macOS)
2. **OpenSandbox lifecycle server** (`pip install opensandbox-server`) -- FastAPI service managing container creation/teardown on port 8080
3. **OpenSandbox execd** -- auto-injected into containers, handles command execution + file I/O
4. **Terragon sandbox Docker image** -- same base image used by Docker/Daytona providers, pre-loaded with git, Node.js, etc.

The Mac Mini needs: outbound internet (for git, npm, API calls from containers) and inbound reachability from the Terragon backend (for the lifecycle server API).

## How Pairing / Registration Works

### Setup Script (hosted by the Terragon app)

The script is served from the Terragon app itself (e.g., `GET /api/mac-mini-setup.sh`). On the Mac Mini, you run:

```bash
curl -sSL https://your-terragon-instance.com/api/mac-mini-setup.sh | bash
```

**What the script does:**

1. Checks prerequisites (macOS version, disk space)
2. Installs Tailscale (if not present), prompts to join the tailnet
3. Installs Docker Desktop or OrbStack (if not present)
4. Installs OpenSandbox server (`pip install opensandbox-server`)
5. Pulls the Terragon sandbox Docker image
6. Generates a random API key for this worker
7. Configures OpenSandbox as a `launchd` service (auto-starts on boot)
8. Starts the lifecycle server
9. **Prompts for a worker name** (e.g., "mac-mini-01")
10. **Generates a QR code in the terminal** (using `qrencode` or a pure-bash approach) containing a JSON payload:

```json
{
  "name": "mac-mini-01",
  "tailscaleIp": "100.64.1.5",
  "port": 8080,
  "apiKey": "sk-mm-abc123...",
  "osVersion": "macOS 15.3",
  "cpuCores": 10,
  "memoryGB": 32
}
```

### QR Code Scanning (from the Terragon app)

**New route:** `apps/www/src/app/(sidebar)/(site-header)/internal/admin/mac-minis/scan/page.tsx`

1. Admin opens `/internal/admin/mac-minis/scan` on their phone (or any device with a camera)
2. Page uses the browser's `BarcodeDetector` API (or a library like `html5-qrcode`) to scan the QR code
3. On scan, the JSON payload is decoded and a confirmation screen shows:
   - Worker name, Tailscale IP, hardware specs
   - "Register this worker?" button
4. On confirm, a server action calls the lifecycle server at that IP to verify connectivity
5. On success, inserts into `macMiniWorker` table with `status = 'online'`
6. Done -- worker is paired and ready to accept tasks

### The script is self-contained

The setup script lives in the repo at `packages/mac-mini-setup/setup.sh` and is served via an API route. It can be versioned and updated. The script also supports a `--uninstall` flag to cleanly remove everything.

## Fleet Management

### DB Schema (new tables in `packages/shared/src/db/schema.ts`)

**`macMiniWorker`** -- registry of machines:

- `id`, `name`, `hostname`, `port`, `apiKeyEncrypted`
- `status`: online | offline | draining | maintenance
- `maxConcurrentSandboxes` (default 1 -- dedicated machine per task)
- `currentSandboxCount`, `lastHealthCheckAt`, hardware info (cores, RAM, disk)

**`macMiniSandboxAllocation`** -- tracks which sandbox is on which worker:

- `workerId`, `sandboxId`, `threadId`, `status` (running/paused/stopped)

### Health Check Cron (`apps/www/src/app/api/internal/cron/mac-mini-health/route.ts`)

- Runs every 60s, pings each worker's `/health` endpoint
- Updates status, reconciles `currentSandboxCount` with actual running containers
- Marks workers `offline` after 3 consecutive failures

## Provider Implementation

### New provider: `packages/sandbox/src/providers/opensandbox-provider.ts`

Follows the Daytona provider pattern (`daytona-provider.ts`). Uses the OpenSandbox TypeScript SDK with `baseUrl` pointed at the assigned Mac Mini.

**OpenSandboxSession** maps to `ISandboxSession`:
| ISandboxSession method | OpenSandbox SDK call |
|---|---|
| `runCommand(cmd)` | `sandbox.commands.run(cmd)` |
| `readTextFile(path)` | `sandbox.files.read_file(path)` |
| `writeTextFile(path, content)` | `sandbox.files.write_files([...])` |
| `hibernate()` | Container stop (preserves filesystem) |
| `shutdown()` | `sandbox.kill()` |

**OpenSandboxProvider** maps to `ISandboxProvider`:
| Method | Behavior |
|---|---|
| `getOrCreateSandbox(id, opts)` | If `id` exists: look up allocation, reconnect to that worker. If null: allocate a worker, create container, record allocation. |
| `getSandboxOrNull(id)` | Look up allocation in DB, try to reconnect |
| `hibernateById(id)` | Find worker, stop container |
| `extendLife(id)` | No-op or reset auto-cleanup timer |

### Allocation Strategy: 1 sandbox per Mac Mini, fallback to Daytona

1. Query workers where `status = 'online'` AND `currentSandboxCount = 0`
2. Pick first available (or least-recently-used)
3. Atomically set `currentSandboxCount = 1` (conditional UPDATE to prevent races)
4. **If none available: automatically fall back to Daytona** -- the provider resolution in `apps/www/src/agent/sandbox.ts` tries OpenSandbox first, falls back to Daytona. User sees which provider their task landed on.
5. On sandbox kill/shutdown: reset `currentSandboxCount = 0`, delete allocation row

## Type & Config Changes

| File                                                             | Change                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/types/src/sandbox.ts`                                  | Add `"opensandbox"` to `SandboxProvider` union          |
| `packages/sandbox/src/provider.ts`                               | Add `case "opensandbox"` to factory switch              |
| `packages/shared/src/model/feature-flags-definitions.ts`         | Add `opensandboxProvider` and `forceOpenSandbox` flags  |
| `apps/www/src/agent/sandbox.ts`                                  | Add OpenSandbox to provider resolution                  |
| `apps/www/src/components/settings/sandbox-provider-selector.tsx` | Add "Mac Mini (OpenSandbox)" option behind feature flag |

## Admin UI

New admin pages following existing patterns:

- **Fleet overview**: `/internal/admin/mac-minis/page.tsx` -- table of workers with status, capacity, actions
- **Worker detail**: `/internal/admin/mac-minis/[id]/page.tsx` -- config, allocations, logs
- **Add worker dialog**: Registration + pairing flow
- **Server actions**: `apps/www/src/server-actions/admin/mac-mini.ts`

## Networking: Tailscale

Each Mac Mini and the Terragon backend join the same Tailscale network. Workers are registered by their stable Tailscale IPs (e.g., `100.x.y.z:8080`). Encrypted, zero-config, works from Vercel via Tailscale relay.

## Hibernation

- `hibernate()` = `docker stop` (container filesystem preserved, processes killed)
- Resume = `docker start` + daemon restart (existing `restartDaemonIfNotRunning` handles this)
- Auto-cleanup timer for stopped containers to reclaim disk (configurable per worker)

## Verification

1. **Unit**: Provider tests against a mock OpenSandbox server
2. **Integration**: Register a single Mac Mini, create a sandbox, run commands, read/write files, hibernate, resume, shutdown
3. **E2E**: Submit a task from the Terragon UI, verify it runs on a Mac Mini, produces a commit/PR
4. **Fleet**: Register multiple workers, submit concurrent tasks, verify load balancing
5. **Health**: Kill a worker's Docker, verify health check marks it offline, new tasks avoid it
