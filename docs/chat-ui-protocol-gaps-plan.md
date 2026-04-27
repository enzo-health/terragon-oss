# Plan: Close Chat-UI Gaps Across Codex app-server, ACP, and Claude Code

**Generated:** 2026-04-14
**Estimated Complexity:** High
**Target branch:** `feat/chat-ui-protocol-gaps` (branched off `main` now; rebase after PR #126 merges)
**Deliverable:** One mega-PR per the user's directive

---

## Overview

Three independent protocol catalogues (Codex app-server JSON-RPC, Agent Client Protocol, Claude Code stream-json) share the same five structural gaps in Terragon's chat UI:

1. Lifecycle events (turn/session/tool start-progress-fail) dropped or only terminal-state-rendered.
2. Streaming deltas (`_delta`, `content_block_delta`, `*/outputDelta`) not surfaced → lumpy UX.
3. Rich content (images, audio, resource_link, terminal, diff) flattened to text.
4. Meta/status (token usage, rate limits, model re-routing, server health, session init) silently dropped.
5. Sub-agent coordination (Codex `collabAgentToolCall`, ACP `Plan`, Claude Code `Task` nested agent) invisible or narration-only.

The fix is one unified `ThreadItem` schema evolution plus per-protocol adapters that map into it, then per-category React renderers. All three protocol sources converge on the same UI primitives, so the work is shared, not triplicated.

### High-level approach

- **One mega-PR** on one branch, built as a sequence of atomic TDD commits per sprint.
- **Strict TDD:** every task starts with a failing test, then minimum implementation, then refactor.
- **No feature flags** — behavior ships on merge.
- **Integration harness** (Sprint 6) is the testability backbone: record real daemon-event POST bodies → replay through the real Next.js API route + UI → assert rendered output. Makes the sandbox↔client contract testable in CI without needing a live sandbox.
- **Schema-first:** the DB `messages.content` shape evolves in Sprint 1 before any renderer work, so later sprints don't thrash migrations.
- **Verification-in-plan:** every protocol payload shape has a "capture real payload from live sandbox; snapshot as test fixture" task, so we don't implement against unverified specs.

### What this PR does NOT include

- Hook event surfacing (Claude Code `PreToolUse` / `PostToolUse` JSON stream output) — marked "needs verification" by research; deferred to a separate follow-up once we confirm whether Claude Code emits hooks into stream-json at all.
- Realtime audio / WebRTC (Codex `thread/realtime/*`) — experimental upstream surface we don't run in prod.
- Codex fuzzy-file-search events (`fuzzyFileSearch/*`) — not a user-visible chat surface.
- Windows sandbox warnings — we don't target Windows sandboxes.

---

## Prerequisites

- **Tooling:** `pnpm install` runs clean; `turbo tsc-check` passes on base `main`; `pnpm -C apps/www test` and `pnpm -C packages/daemon test` both pass on base.
- **Daytona CLI** authenticated for capturing live sandbox payloads (Sprint 0, Task 0.3).
- **Prod DB read-only access** for fixture capture, using the same `.env.prod.local` workflow we established in this session. Delete after use.
- **Base branch:** `main` (PR #126's commits absent from this branch; if #126 merges first, rebase and drop overlapping hunks in `codex-app-server.ts` / `daemon.ts`).
- **Upstream references pinned** (Sprint 0, Task 0.2): Codex Rust types from a known `openai/codex` SHA; ACP spec from a known `zed-industries/agent-client-protocol` SHA.

---

## Sprint 0: Foundation — fixtures, types, branch

**Goal:** Establish ground truth for every payload shape we'll implement against, before writing any production code. Lock in the branch and baseline.

**Demo/Validation:**

- `git log origin/main..HEAD` shows the Sprint 0 commits and nothing else.
- `packages/daemon/src/__fixtures__/` contains at least one captured JSON payload per protocol event we intend to handle.
- A short `docs/chat-ui-protocol-gaps-references.md` lists upstream SHAs we treat as spec truth.

### Task 0.1: Create branch off `main`

- **Location:** local git state
- **Description:** `git checkout main && git pull && git checkout -b feat/chat-ui-protocol-gaps`. Confirm branch diverges from `main` with zero commits.
- **Dependencies:** none
- **Acceptance Criteria:**
  - `git rev-list --count main..HEAD == 0` at start.
  - `git status` clean.
- **Validation:** `git log --oneline main..HEAD` prints nothing.

### Task 0.2: Pin upstream spec SHAs in a reference doc

- **Location:** `docs/chat-ui-protocol-gaps-references.md`
- **Description:** Write a short doc naming (a) the `openai/codex` repo SHA whose `codex-rs/app-server-protocol/src/protocol/common.rs` and `.../v2.rs` we treat as canonical for notification/item types, (b) the `zed-industries/agent-client-protocol` SHA we treat as canonical for ACP, and (c) the `@anthropic-ai/claude-code` version we're targeting. Include one-paragraph rationale ("we pin SHAs so future divergence is visible in a PR").
- **Dependencies:** 0.1
- **Acceptance Criteria:**
  - Doc exists and names three specific immutable references (SHA, tag, or npm version).
  - Doc contains a "how to refresh" section (4–6 lines) describing how to re-verify when upstream moves.
- **Validation:** `markdownlint docs/chat-ui-protocol-gaps-references.md` clean (or manual read-through if linter not present).

### Task 0.2.5: Build the daemon `DEBUG_DUMP_NOTIFICATIONS` harness

- **Location:** `packages/daemon/src/daemon.ts` (guarded behind an env flag, shipped code stays in mainline so we can re-capture in the future)
- **Description:** Add a small tee in the notification-receive path: when `DEBUG_DUMP_NOTIFICATIONS=<dir>` is set at daemon startup, every raw JSON-RPC notification is appended as a line to `<dir>/<threadChatId>.jsonl` before any parsing. Write a unit test that starts the daemon with the flag, feeds a synthetic notification, asserts the file content. This harness is permanent — left in the tree behind the env flag so fixture capture is a one-command operation forever, not a one-off modification + revert. Ship the bundle to the target sandbox once (rebuild `packages/bundled`, restart daemon via sandbox exec).
- **Dependencies:** 0.1
- **Acceptance Criteria:**
  - Env flag works in both test and a live sandbox.
  - Zero overhead when flag unset (measured by a microbench in the test).
  - Test committed alongside the feature.
- **Validation:** `pnpm -C packages/daemon vitest run src/daemon.test.ts -t "DEBUG_DUMP_NOTIFICATIONS"` passes; live sandbox capture produces a non-empty `.jsonl` within 30s of triggering a task.

### Task 0.3: Capture one real Codex `collabAgentToolCall` payload from a live sandbox

- **Location:** `packages/daemon/src/__fixtures__/codex/collab-agent-tool-call-started.json`, `.../collab-agent-tool-call-completed.json`
- **Description:** Using the 0.2.5 harness, deploy the harness-enabled daemon bundle to a test Daytona sandbox (`daytona exec <id> -- ...`), trigger a multi-agent task, capture one `item/started` + one `item/completed` with `itemType=collabAgentToolCall`, save as fixture files. This verifies the real payload shape against the upstream Rust `ThreadItem` enum before we implement anything. Harness code stays in mainline (see 0.2.5) — only the env flag is flipped off.
- **Dependencies:** 0.1, 0.2.5
- **Acceptance Criteria:**
  - Two fixture JSON files exist and parse as valid JSON.
  - Each has the shape `{ "jsonrpc": "2.0", "method": "item/started" | "item/completed", "params": { ... full payload ... } }`.
  - Debug flag is reverted from code before sprint closes (the fixtures stay; the dump path doesn't).
- **Validation:** `jq -r .method < ...started.json` returns `item/started`; `jq '.params.item.type' < ...completed.json` returns `"collabAgentToolCall"`.

### Task 0.4: Capture fixtures for every other Codex event we plan to handle

- **Location:** `packages/daemon/src/__fixtures__/codex/*.json`
- **Description:** Using the same debug-dump technique, capture at least one real sample of each of: `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`, `item/mcpToolCall/progress`, `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, `mcpServer/startupStatus/updated`, `account/rateLimits/updated`, `model/rerouted`. For any event we cannot elicit in-sandbox within 30 min of trying, fall back to a synthetic fixture built from the upstream Rust type definition and mark the fixture file with a `// synthesized` header comment.
- **Dependencies:** 0.3
- **Acceptance Criteria:**
  - Every item above has a fixture file.
  - Fixtures from synthesis are marked as such.
  - Each fixture has a corresponding `.md` note explaining capture method.
- **Validation:** `ls packages/daemon/src/__fixtures__/codex/*.json | wc -l` matches the intended count; spot-check 3 random fixtures with `jq` for required fields.

### Task 0.5: Capture ACP session/update fixtures

- **Location:** `packages/daemon/src/__fixtures__/acp/*.json`
- **Description:** Spin up a Claude Code (ACP) run in a Daytona sandbox, enable debug dump, capture one fixture per ACP content-block type we plan to render: `agent_message_chunk`, `thought`, `tool_call`, `tool_call_update`, `plan` update, `image`, `audio`, `resource_link`, `terminal`, `diff`, `session/request_permission`. For content types Claude Code's sandbox-agent doesn't emit during a typical run (e.g. `audio`, `image`), synthesize from the public ACP spec and mark synthesized.
- **Dependencies:** 0.3
- **Acceptance Criteria:**
  - Every item above has a fixture file under `__fixtures__/acp/`.
  - Each contains the full `session/update` envelope, not just the inner block.
- **Validation:** `jq '.params.update.sessionUpdate' < ...` matches the ACP spec's discriminant for each fixture.

### Task 0.6: Capture Claude Code stream-json fixtures

- **Location:** `packages/daemon/src/__fixtures__/claude-code/*.json`
- **Description:** Run a Claude Code CLI-path task (non-ACP transport) with `--output-format stream-json --include-partial-messages`, capture one instance each of: `system` init, `assistant` text, `assistant` thinking, `assistant` tool_use (one built-in, one MCP), `message_delta`, `content_block_delta` (text + input_json), `result` success, `custom-error`, `custom-stop`. Existing unit tests already exercise some of these — reuse their inline fixtures, but normalize into this directory so all three protocols have the same structure.
- **Dependencies:** 0.3
- **Acceptance Criteria:**
  - Every item above has a fixture file under `__fixtures__/claude-code/`.
  - Files are referenced from existing tests where applicable (no inline JSON duplication).
- **Validation:** `grep -c 'inline fixture' packages/daemon/src/**/*.test.ts` trends down from baseline; fixtures load with `JSON.parse(fs.readFileSync(...))` in a one-liner test.

---

## Sprint 1: Schema evolution — unified `ThreadItem` + `MessagePart` shapes

**Goal:** Change `@terragon/shared`'s message/item types to accept the full range of rich content blocks and lifecycle states, with a DB migration. No renderer work yet; just the schema and its migration.

**Demo/Validation:**

- `pnpm -C packages/shared drizzle-kit-push-dev` applies migration cleanly against dev DB.
- `turbo tsc-check` passes across all packages.
- All existing tests pass (no behavior change — existing content is backward-compatible).
- One new test proves a structured content block round-trips through DB + shared types without loss.

### Task 1.1: Add `DelegationItem` variant to `ThreadItem` union

- **Location:** `packages/shared/src/model/thread-item.ts` (or whichever file defines the union; identified in Sprint 0 investigation)
- **Description:** Write a failing test first (`packages/shared/src/model/thread-item.test.ts`) that constructs a `DelegationItem` with fields `{ id, senderThreadId, receiverThreadIds: string[], prompt, model, reasoningEffort?, agentsStates: Record<string, "initiated"|"running"|"completed"|"failed">, tool: "spawn"|"message"|"kill", status: "initiated"|"running"|"completed"|"failed" }` and asserts the zod/discriminated-union parser accepts it. Run test → fails (variant doesn't exist). Add variant; test passes.
- **Dependencies:** 0.2
- **Acceptance Criteria:**
  - Test committed first in a failing state (can be squashed later).
  - Type accepts every field Codex `collabAgentToolCall` produces (verified against 0.3 fixture).
  - Existing `ThreadItem` parser still accepts all pre-existing variants (regression coverage via existing tests).
- **Validation:** `pnpm -C packages/shared test -- thread-item` passes; fixture from 0.3 parses into the new variant via `ThreadItem.parse(fixture.params.item)`.

### Task 1.2: Add structured-content variants to `MessagePart`

- **Location:** `packages/shared/src/model/message-part.ts` (or equivalent)
- **Description:** Write failing tests for each new variant — `ImagePart { id, mimeType, data | uri }`, `AudioPart { id, mimeType, data | uri }`, `ResourceLinkPart { id, uri, name, title?, description?, mimeType?, size? }`, `TerminalPart { id, sandboxId, terminalId, chunks: Array<{ streamSeq, kind: "stdout"|"stderr"|"interaction", text }> }`, `DiffPart { id, filePath, oldContent?, newContent, unifiedDiff?, status: "pending"|"applied"|"rejected" }`. Tests round-trip each through zod + JSON. Run tests → fail. Add variants; tests pass.
- **Dependencies:** 1.1
- **Acceptance Criteria:**
  - Each new part type has a test that covers: valid parse, invalid parse (missing required field), round-trip through `JSON.parse(JSON.stringify(x))`.
- **Validation:** `pnpm -C packages/shared test -- message-part` passes.

### Task 1.2.5: Add lenient-parse wrapper for `MessagePart` + `ThreadItem`

- **Location:** `packages/shared/src/model/message-part.ts`, `packages/shared/src/model/thread-item.ts`
- **Description:** Add `parseMessagePartLenient(raw: unknown): MessagePart | UnknownPart` and equivalent for `ThreadItem`. Unknown variants are preserved as `{ type: "unknown", raw }` (displayed as plain text by UI) rather than throwing. Existing strict parsers stay for write-path validation; read-path switches to lenient so (a) old rows predating this PR still render after the schema widens, (b) new rows written by a newer daemon still render on older deployed frontends during rollouts. Write failing tests: old shape → parses, unknown shape → parses as `UnknownPart`, malformed shape (non-object) → returns `UnknownPart` with raw captured. Implement.
- **Dependencies:** 1.2
- **Acceptance Criteria:**
  - Strict parse is still available and still rejects invalid shapes (write path).
  - Lenient parse never throws on object inputs.
  - All call sites that read from DB use lenient; all call sites that accept user/daemon input use strict.
- **Validation:** `pnpm -C packages/shared test -- message-part-lenient` passes; grep confirms lenient is used in DB read paths and strict is used in API input validation.

### Task 1.3: Add lifecycle-aware fields to existing tool-call parts

- **Location:** `packages/shared/src/model/message-part.ts`
- **Description:** Tool-call parts currently store only terminal state. Add optional fields `startedAt?, progressChunks?: Array<{ seq, text }>, completedAt?, status: "started"|"in_progress"|"completed"|"failed"` to the existing tool-call variant (preserving backward compatibility). Write test that constructs a tool-call part with only the old fields (parses) and with the new fields (parses).
- **Dependencies:** 1.2
- **Acceptance Criteria:**
  - Old serialized shapes still parse (migration-safe).
  - New optional fields are non-breaking.
- **Validation:** `pnpm -C packages/shared test` full suite passes.

### Task 1.4: DB migration — no structural change, only widen JSONB validation

- **Location:** `packages/shared/src/db/schema.ts` + generated migration in `packages/shared/drizzle/`
- **Description:** The `messages.content` column is already JSONB; no column changes needed. This task is to (a) bump a `schemaVersion` constant read on write-path to signal downstream code that new shapes may appear, (b) generate and check in a Drizzle no-op/annotation migration that records the schema version bump, (c) write a test that inserts a row with a new `DelegationItem`, reads it back, and deep-equals it. If zero schema change is ultimately needed, this task closes with a code-only `schemaVersion` constant bump + test, no migration.
- **Dependencies:** 1.3
- **Acceptance Criteria:**
  - `pnpm -C packages/shared drizzle-kit-push-dev` applies cleanly (idempotent if no migration generated).
  - Round-trip insert/read test passes against a real Postgres (via Vitest global setup).
- **Validation:** `pnpm -C packages/shared test -- db-messages-roundtrip` passes.

---

## Sprint 2: Codex adapter — lifecycle events + delta streaming

**Goal:** Surface every Codex app-server event Terragon currently drops: turn diffs/plans, command/file/reasoning deltas, token usage, MCP progress, auto-approval reviews, model re-routing. Each event maps to an existing or new message-part variant via `extractThreadEvent` / `normalizeThreadItem`.

**Demo/Validation:**

- Replay the Sprint 0 Codex fixtures through `packages/daemon/src/codex-app-server.ts` in a vitest harness; every fixture produces a non-null `ThreadEvent`.
- `pnpm -C packages/daemon test` passes; new tests number ≥ number of Codex fixtures.
- In a live Daytona sandbox run, `grep 'Unknown Codex notification' /tmp/terragon-daemon.log` returns zero hits after this sprint.

### Task 2.1: Map `collabAgentToolCall` to `DelegationItem`

- **Location:** `packages/daemon/src/codex-app-server.ts`
- **Description:** Write failing test that loads fixture from 0.3, runs `extractThreadEvent`, asserts it returns a `ThreadEvent` of kind `item.started` with `item` parsing into the Sprint 1.1 `DelegationItem` variant. Run test → fails (currently silently ignored). Remove `"collabAgentToolCall"` from `SILENTLY_IGNORED_ITEM_TYPES`; add a `collabagenttoolcall` case to `normalizeThreadItemType`; add fields extraction in `normalizeThreadItem`. Test passes.
- **Dependencies:** 1.1, 0.3
- **Acceptance Criteria:**
  - Fixture parses into a `DelegationItem` with every field populated (`senderThreadId`, `receiverThreadIds`, `prompt`, `model`, `reasoningEffort`, `agentsStates`, `tool`, `status`).
  - Existing `SILENTLY_IGNORED_ITEM_TYPES includes collabAgentToolCall` test from PR #126 is removed or inverted to assert it's NOT in the set.
- **Validation:** `pnpm -C packages/daemon vitest run src/codex-app-server.test.ts` → all green.

### Task 2.2: Handle `turn/diff/updated` and `turn/plan/updated`

- **Location:** `packages/daemon/src/codex-app-server.ts` — extend `METHOD_TO_THREAD_EVENT_TYPE` + `extractThreadEventFromMethod`
- **Description:** Write failing tests that feed each fixture into `extractThreadEvent` and assert it produces a `ThreadEvent` with kind `turn.diff_updated` / `turn.plan_updated`, carrying the unified diff / plan breakdown respectively. Implement mapping. Tests pass.
- **Dependencies:** 1.2 (diff needs `DiffPart`), 0.4
- **Acceptance Criteria:**
  - Each method is in `METHOD_TO_THREAD_EVENT_TYPE`.
  - Payload fields are preserved losslessly.
- **Validation:** Both fixture-driven tests pass.

### Task 2.3: Handle `item/commandExecution/outputDelta` streaming

- **Location:** `packages/daemon/src/codex-app-server.ts` — mirror the existing `item/agentMessage/delta` synthetic-event pattern
- **Description:** Write failing test that feeds the fixture, asserts `extractThreadEvent` returns a synthetic `item.updated` event whose `item` has an appended `progressChunks[]` entry. Implement the handler alongside the existing agentMessage-delta case. Test passes.
- **Dependencies:** 1.3, 0.4
- **Acceptance Criteria:**
  - Command-execution items accumulate `progressChunks` on each delta.
  - The daemon's delta-buffer streaming path (from PR #126) picks up command deltas so the UI can render char-by-char without a full POST per chunk.
- **Validation:** Fixture test passes; manual: running `ls -la` in a live sandbox shows output streaming in the UI (Sprint 6 harness will automate this).

### Task 2.4: Handle `item/fileChange/outputDelta`

- **Location:** `packages/daemon/src/codex-app-server.ts`
- **Description:** Same pattern as 2.3. Failing test → implement → pass. Maps to `DiffPart.unifiedDiff` being progressively built.
- **Dependencies:** 1.2, 1.3, 0.4

### Task 2.5: Handle reasoning deltas (`item/reasoning/summaryTextDelta`, `summaryPartAdded`, `textDelta`)

- **Location:** `packages/daemon/src/codex-app-server.ts`
- **Description:** Failing tests → implement → pass. Each maps to an `item.updated` event that appends to the reasoning item's summary or content array.
- **Dependencies:** 1.3, 0.4

### Task 2.6: Handle `item/mcpToolCall/progress`

- **Location:** `packages/daemon/src/codex-app-server.ts`
- **Description:** Failing test → implement → pass. Maps to tool-call part progress updates (Sprint 1.3 fields).
- **Dependencies:** 1.3, 0.4

### Task 2.7: Handle auto-approval review events

- **Location:** `packages/daemon/src/codex-app-server.ts`
- **Description:** `item/autoApprovalReview/started` + `completed`. Maps to a new `AutoApprovalReviewPart` message part (add in this task if not done in Sprint 1; prefer adding to Sprint 1 retroactively via small sprint-1 follow-up commit). Failing test → implement → pass.
- **Dependencies:** 1.2, 0.4

### Task 2.8: Handle meta events — `thread/tokenUsage/updated`, `account/rateLimits/updated`, `model/rerouted`, `mcpServer/startupStatus/updated`, `thread/status/changed`, `configWarning`, `deprecationNotice`

- **Location:** `packages/daemon/src/codex-app-server.ts` + a new `ThreadMetaEvent` broadcast channel in `packages/daemon/src/daemon.ts` (not a `ThreadItem`; these are orthogonal status signals, not chat content)
- **Description:** Failing tests per event type, asserting each produces a `ThreadMetaEvent` dispatched on a meta channel (separate from the content stream). Implement; define the meta event union in `@terragon/shared`.
- **Dependencies:** 0.4
- **Acceptance Criteria:**
  - Meta events don't pollute the `ThreadItem` stream (UI renders them as header chips, not chat bubbles — Sprint 5).
- **Validation:** Tests pass; a snapshot of the meta event stream from replaying all meta fixtures matches a recorded JSON snapshot.

### Task 2.9: Silence-set shrinks to only `userMessage`

- **Location:** `packages/daemon/src/codex-app-server.ts`
- **Description:** After 2.1–2.8, `SILENTLY_IGNORED_ITEM_TYPES` should only retain `userMessage` (the echo of user input that has no UI utility). Assert this in a test. This locks in the "every unknown type was explicitly considered" invariant.
- **Dependencies:** 2.1–2.8
- **Acceptance Criteria:**
  - `expect(SILENTLY_IGNORED_ITEM_TYPES).toEqual(new Set(["userMessage"]))`
- **Validation:** Test passes.

---

## Sprint 3: ACP adapter — rich content + tool-call lifecycle

**Goal:** Parse every ACP content block we currently flatten or drop: `image`, `audio`, `resource_link`, `terminal`, `diff`, `tool_call` + `tool_call_update`, `plan`. Each maps to the Sprint 1 `MessagePart` variants.

**Demo/Validation:**

- Replay Sprint 0 ACP fixtures through the adapter; each produces the correct part.
- Tool-call lifecycle test: feed `tool_call` → `tool_call_update (in_progress)` → `tool_call_update (completed)` → assert the final state carries both intermediate progress and final output.

### Task 3.1: Locate ACP adapter entry point and add content-type dispatch stub

- **Location:** `packages/daemon/src/acp-adapter.ts` (verify path during work)
- **Description:** Before adding handlers, refactor the adapter to route by `update.sessionUpdate` discriminant so new content types can be added as isolated case handlers. Write a test that asserts dispatch throws a named error for unknown types (not silent fallthrough).
- **Dependencies:** Sprint 1 complete
- **Acceptance Criteria:**
  - Refactor does not change output for existing handled types (snapshot tests still pass).
  - Unknown types throw `UnknownAcpContentTypeError` — visible failure, not silent drop.

### Task 3.2: Map ACP `tool_call` + `tool_call_update` to lifecycle-aware tool parts

- **Location:** `packages/daemon/src/acp-adapter.ts`
- **Description:** TDD: test feeds `tool_call { id, toolKind, title, locations[] }` followed by one or more `tool_call_update { id, status, content, rawInput, rawOutput }`, asserts final `ToolCallPart` state carries the full lifecycle. Implement.
- **Dependencies:** 1.3, 3.1, 0.5
- **Acceptance Criteria:**
  - `title`, `toolKind`, `locations` from the initial `tool_call` flow through to the part.
  - Updates accumulate, they don't replace (except for `status` which is a discrete field).

### Task 3.3: Map ACP `plan` updates to a `PlanPart`

- **Location:** `packages/daemon/src/acp-adapter.ts` + `packages/shared/src/model/message-part.ts` (if not added in Sprint 1)
- **Description:** ACP plan entries carry `{ priority, status, content }`. Test → implement. Plan updates are idempotent by entry `content` or `id` — model as replace-on-id.
- **Dependencies:** 1.2, 3.1, 0.5

### Task 3.4: Map ACP `image` / `audio` / `resource_link` content blocks

- **Location:** `packages/daemon/src/acp-adapter.ts`
- **Description:** One failing test per type. Implementation preserves structure (data or uri), never flattens to text.
- **Dependencies:** 1.2, 3.1, 0.5

### Task 3.5: Map ACP `terminal` content to `TerminalPart`

- **Location:** `packages/daemon/src/acp-adapter.ts`
- **Description:** Codex already has partial `TerminalEmbedded` rendering; generalize. Test with fixture. Implementation streams `chunks` append-only.
- **Dependencies:** 1.2, 3.1, 0.5

### Task 3.6: Map ACP `diff` to `DiffPart`

- **Location:** `packages/daemon/src/acp-adapter.ts`
- **Description:** Same pattern. Test → implement.
- **Dependencies:** 1.2, 3.1, 0.5

### Task 3.7: Map ACP `session/request_permission` to permission UI event

- **Location:** `packages/daemon/src/acp-adapter.ts`
- **Description:** Terragon already has synthetic `PermissionRequest` tool calls. Verify the ACP request flows through; add a test covering: request received → UI event emitted → user's resolution POSTed back → ACP `session/approve_tool_use` sent. Existing path may already work — this task is principally test coverage + any bug fixes found.
- **Dependencies:** 3.1, 0.5
- **Acceptance Criteria:**
  - End-to-end permission round-trip test passes.

### Task 3.8: Assert every ACP `sessionUpdate` discriminant is covered

- **Location:** `packages/daemon/src/acp-adapter.test.ts`
- **Description:** Write a test that iterates over the ACP spec's known `sessionUpdate` discriminant values and asserts the adapter has a case for each (exhaustiveness check via TypeScript's `never` guard in the dispatch + a runtime enumeration for docs). If any are unhandled and we deliberately skip (e.g. audio if Terragon doesn't support it), the test asserts the adapter throws a clear `UnsupportedAcpContentTypeError` rather than silently dropping.
- **Dependencies:** 3.1–3.7

---

## Sprint 4: Claude Code adapter — streaming deltas + system init

**Goal:** Parse raw Claude Code `stream-json` events we currently ignore: `system` init, `message_delta` (usage + stop_reason), `content_block_delta` (`text_delta`, `input_json_delta`), `message_stop`. Tool-specific renderers are already solid; this sprint is about streaming granularity and session-init visibility.

**Demo/Validation:**

- Replay Sprint 0 Claude Code fixtures; each `content_block_delta` produces a delta buffer entry for the PR-#126 streaming path.
- `system` init events produce a `ThreadMetaEvent` with tools list + MCP server list.

### Task 4.1: Parse `system` init message

- **Location:** `packages/daemon/src/claude.ts` (or wherever `parseClaudeLine` lives; verify in Sprint 0)
- **Description:** TDD. Parser currently consumes system messages without surfacing them. Emit `ThreadMetaEvent { kind: "session.initialized", tools, mcpServers }`.
- **Dependencies:** 2.8 (meta event channel), 0.6

### Task 4.2: Parse `content_block_delta` → `text_delta` into the delta buffer

- **Location:** `packages/daemon/src/claude.ts`
- **Description:** Reuse PR-#126's delta buffer infrastructure. TDD. Each delta becomes a buffered entry with `messageId`, `deltaSeq`, `kind: "text"`, `text`.
- **Dependencies:** 0.6

### Task 4.3: Parse `content_block_delta` → `input_json_delta` into tool-call progress

- **Location:** `packages/daemon/src/claude.ts`
- **Description:** For streaming tool-use input, accumulate `partial_json` fragments into the tool-call part's progress. TDD.
- **Dependencies:** 1.3, 0.6

### Task 4.4: Parse `content_block_delta` for `thinking` deltas

- **Location:** `packages/daemon/src/claude.ts`
- **Description:** Thinking content blocks stream too. TDD. Buffer as `kind: "thinking"` entries so the existing PR-#126 streaming UI handles them identically to text.
- **Dependencies:** 0.6

### Task 4.5: Parse `message_delta` for usage + stop_reason

- **Location:** `packages/daemon/src/claude.ts`
- **Description:** Emit `ThreadMetaEvent { kind: "usage.incremental", inputTokens, outputTokens, cacheCreation, cacheRead }` and `{ kind: "message.stop", reason }`. TDD.
- **Dependencies:** 2.8, 0.6

### Task 4.6: Unify MCP tool metadata surface

- **Location:** `packages/daemon/src/claude.ts` + `packages/shared/src/model/tool-metadata.ts` (new or extended)
- **Description:** For `tool_use` with `name` matching `mcp__<server>__<tool>`, parse and attach server metadata (server name, tool name) as a dedicated field on the tool-call part. Write failing test that asserts the structured field is populated. Implement.
- **Dependencies:** 0.6

---

## Sprint 5: UI renderers — one component per new part/event

**Goal:** Every new part or meta event from Sprints 2–4 has a React component rendering it. One component per commit. All components exhaustively tested with Ladle stories + unit tests, no new `DefaultTool` fallbacks.

**Demo/Validation:**

- `pnpm -C apps/www test -- src/components/chat` all green.
- Running `pnpm -C apps/www ladle` and visiting each new component story renders the fixture correctly.
- `apps/www/src/components/chat/message-part.tsx` router has explicit dispatch for every new part type — no `default: return null`.

### Task 5.1: `<DelegationItemCard>` component

- **Location:** `apps/www/src/components/chat/delegation-item-card.tsx` + `.stories.tsx` + `.test.tsx`
- **Description:** Renders sender/receiver agent relationship, prompt, status badge per sub-agent, live status updates via props. TDD: snapshot test for each of `initiated`/`running`/`completed`/`failed`. Story with fixture from 0.3.
- **Dependencies:** 2.1

### Task 5.2: `<DiffPartView>` component

- **Location:** `apps/www/src/components/chat/diff-part.tsx`
- **Description:** Renders unified diff with syntax highlighting, file-path header, accept/reject buttons if `status === "pending"`. Reuse existing diff viewer if present. TDD.
- **Dependencies:** 1.2, 2.2, 2.4, 3.6

### Task 5.3: `<PlanPartView>` component

- **Location:** `apps/www/src/components/chat/plan-part.tsx`
- **Description:** Renders plan entry list with `priority` color coding and `status` icon. Handles incremental updates (entries added/updated, not replaced). TDD.
- **Dependencies:** 3.3, 2.2

### Task 5.4: `<TerminalPartView>` component

- **Location:** `apps/www/src/components/chat/terminal-part.tsx`
- **Description:** Renders `chunks[]` append-only with auto-scroll, distinct styling for stdout/stderr/interaction. If an existing `SandboxTerminalEmbedded` covers this, extend it; else new component. TDD.
- **Dependencies:** 1.2, 3.5, 2.3 (command output also flows here)

### Task 5.5: `<AutoApprovalReviewCard>` component

- **Location:** `apps/www/src/components/chat/auto-approval-review-card.tsx`
- **Description:** Shows the target action, guardian risk level, decision (pending → approved/denied). TDD + story.
- **Dependencies:** 2.7

### Task 5.7: Header meta chips (`<UsageChip>`, `<RateLimitChip>`, `<ModelRoutingChip>`, `<McpServerHealthChip>`)

- **Location:** `apps/www/src/components/chat/meta-chips/*.tsx`
- **Description:** Subscribe to the `ThreadMetaEvent` channel. Each chip has: idle state, active state, warning state (e.g. >80% quota). TDD + one story per chip state.
- **Dependencies:** 2.8, 4.1, 4.5

### Task 5.8: Enhance tool-call renderer to show progressive input + output

- **Location:** `apps/www/src/components/chat/tool-part.tsx` and the individual tool renderers
- **Description:** For tool-call parts with `progressChunks`, render them inline before the final output. For parts with `status: "in_progress"`, show a live spinner. TDD for each built-in tool renderer that adds this affordance.
- **Dependencies:** 1.3, 3.2, 4.3

### Task 5.9: `message-part.tsx` router exhaustiveness check

- **Location:** `apps/www/src/components/chat/message-part.tsx`
- **Description:** Switch on part `type` discriminant; TypeScript `never` guard in the `default` case ensures future part types can't be forgotten. Test case constructs a part of every union member and asserts a component is rendered (not `null`).
- **Dependencies:** 5.1–5.8

---

## Sprint 6: Integration harness — sandbox ↔ client contract tests

**Goal:** A replay-based integration test that takes a recorded `daemon-event` POST stream and replays it through the real Next.js API route + chat UI, asserting the rendered DOM. This is the tool the user specifically asked for — it makes the daemon↔client contract testable in CI without needing a live sandbox.

**Demo/Validation:**

- `pnpm -C apps/www test -- integration/` runs an end-to-end replay of one full Codex turn and one full Claude Code turn, asserting specific DOM elements appear.
- A `pnpm recorder` CLI captures a real daemon-event stream from a live sandbox to `apps/www/test/integration/recordings/*.jsonl` for use as future fixtures.

### Task 6.1: Define the recording format

- **Location:** `apps/www/test/integration/types.ts`
- **Description:** Type `RecordedDaemonEvent = { wallClockMs: number, body: DaemonEventAPIBody, headers: Record<string, string> }`. Each line of a `.jsonl` recording is one of these. Write a test that parses a hand-written sample.
- **Dependencies:** 0.6 (we have fixtures)
- **Acceptance Criteria:**
  - Type is the ONLY contract the recorder and replayer share.

### Task 6.2: Build the `recorder` CLI (captures real sandbox traffic)

- **Location:** `apps/www/test/integration/recorder.ts` + a pnpm script `pnpm recorder`
- **Description:** Runs as a local HTTP proxy. Points a real Daytona sandbox's daemon at the proxy via `TERRAGON_SERVER_URL` env override. Proxies to prod (or staging, or local dev) AND tees every POST to a `.jsonl` file. TDD: test that a synthetic POST through the proxy is both forwarded and written.
- **Dependencies:** 6.1
- **Acceptance Criteria:**
  - Invoking `pnpm recorder --out recording.jsonl --forward-to http://localhost:3000` captures traffic.
  - `head -1 recording.jsonl | jq` parses as `RecordedDaemonEvent`.

### Task 6.3: Build the replayer (drives the API route)

- **Location:** `apps/www/test/integration/replayer.ts`
- **Description:** Takes a `.jsonl` recording, POSTs each event to the real Next.js API route (via Vitest + Next's app-router test harness or a spawned Next server), respects `wallClockMs` gaps (or fast-forwards in test mode). TDD: given a fixture recording of 3 events, the replayer invokes the route 3 times in correct order.
- **Dependencies:** 6.1

### Task 6.4: Build the UI assertion harness

- **Location:** `apps/www/test/integration/chat-page.tsx` + support code
- **Description:** Renders `<ChatUI>` pointed at an in-memory thread state that the replayer writes to. Uses React Testing Library. TDD: a test that replays two delta events and asserts the DOM contains the streamed text.
- **Dependencies:** 6.3, Sprint 5 components

### Task 6.5: Record one canonical Codex turn

- **Location:** `apps/www/test/integration/recordings/codex-collab-agent-turn.jsonl`
- **Description:** Use the recorder against a live Daytona sandbox with a prompt that reliably produces a `collabAgentToolCall`. Commit the recording.
- **Dependencies:** 6.2
- **Acceptance Criteria:**
  - Recording contains at least one of: delegation start, delegation completed, command exec delta, file change delta.

### Task 6.6: Record one canonical Claude Code turn

- **Location:** `apps/www/test/integration/recordings/claude-code-standard-turn.jsonl`
- **Description:** Same but for Claude Code path. Covers `system` init, tool_use, text streaming, result.
- **Dependencies:** 6.2

### Task 6.7: End-to-end test: Codex turn renders all expected UI elements

- **Location:** `apps/www/test/integration/codex-turn.test.tsx`
- **Description:** Replay 6.5, assert DOM has: `<DelegationItemCard>`, `<TerminalPartView>` with streamed output, status chips update, no unknown-notification warnings.
- **Dependencies:** 6.4, 6.5, Sprint 5 components

### Task 6.8: End-to-end test: Claude Code turn renders all expected UI elements

- **Location:** `apps/www/test/integration/claude-code-turn.test.tsx`
- **Description:** Replay 6.6, assert DOM has: session init chip, tool-use cards for every tool, streaming text, usage chip updates on `message_delta`.
- **Dependencies:** 6.4, 6.6, Sprint 5 components

### Task 6.9: CI wiring

- **Location:** `.github/workflows/*.yml`
- **Description:** Add the integration suite to the existing Tests job (or a parallel job if runtime > 2 min). Cache recordings (they're committed fixtures, not generated).
- **Dependencies:** 6.7, 6.8

---

## Sprint 7: Polish, soak, and PR-readiness

**Goal:** The mega-PR is actually mergeable. All tests pass, manual smoke against a real sandbox works, docs updated, PR description written.

### Task 7.1: Manual end-to-end smoke

- **Location:** N/A (manual)
- **Description:** Deploy the branch to a staging Vercel preview, point a fresh Daytona sandbox at it, run a multi-step Codex task with sub-agent delegation. Capture screenshots of each new UI affordance. Paste into PR description.
- **Dependencies:** all prior sprints

### Task 7.2: Update AGENTS.md / CLAUDE.md with new architecture

- **Location:** `AGENTS.md`, `CLAUDE.md` at repo root
- **Description:** Add sections for the unified `ThreadItem` / `MessagePart` schema, the meta-event channel, and the integration harness. Remove stale descriptions.
- **Dependencies:** all prior sprints

### Task 7.3: Write the PR description

- **Location:** `.github/PULL_REQUEST_TEMPLATE.md` compliance
- **Description:** Sections: Summary, per-sprint changes, schema migration notes, deploy order (frontend + daemon + sandbox image must all ship), test plan with screenshots from 7.1, rollback (revert the whole PR — no partial state is safe).
- **Dependencies:** 7.1, 7.2

### Task 7.4: Rebase onto latest `main`

- **Location:** git
- **Description:** If PR #126 has merged in the meantime, rebase; resolve conflicts in `codex-app-server.ts` (our changes supersede #126's silencing of `collabAgentToolCall`) and in `daemon.ts` (no conflicts expected since our delta work is additive). Full test suite re-run.
- **Dependencies:** all prior sprints

### Task 7.5: Open the PR

- **Location:** GitHub
- **Description:** `gh pr create --base main --title "feat(chat): unified protocol coverage across Codex, ACP, Claude Code" --body-file PR_BODY.md`. Request reviewers per team convention.
- **Dependencies:** 7.4

---

## Testing Strategy

- **Strict TDD per task:** every production change starts with a failing test in the same commit (or a preceding commit in the same sprint). No "I'll add the test later" is accepted; spec reviewer agents in the subagent-driven-development workflow will reject such tasks.
- **Fixture-driven:** no inline payload JSON in tests after Sprint 0; every test references a file in `__fixtures__/<protocol>/`.
- **Contract tests** (Sprint 6): the replay harness is the regression firewall. Any protocol-adapter change must keep the recorded turns rendering identically unless the recording is intentionally re-captured (recording change is reviewed separately).
- **Vitest for unit/integration; RTL for component DOM assertions.**

## Potential Risks & Gotchas

| Risk                                                                                                                                                                                       | Mitigation                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collabAgentToolCall` real payload differs from upstream Rust definition                                                                                                                   | Sprint 0 Task 0.3 captures the live payload and makes it the fixture-of-record; any divergence is caught at fixture time, before implementation.                                                                                                                                   |
| DB migration is ultimately structural after all (if JSONB validation becomes a constraint)                                                                                                 | Sprint 1.4 has a task to produce a real migration if needed, not a no-op. Test inserts/reads a new shape against a real Postgres via Vitest global setup.                                                                                                                          |
| Sprint 3 ACP adapter refactor breaks existing tool-call rendering                                                                                                                          | Sprint 3 Task 3.1 enforces that the refactor is behavior-preserving via snapshot tests on existing fixtures before any new handlers are added.                                                                                                                                     |
| Sprint 5 component explosion (10+ new components) breaks bundle size budget                                                                                                                | Sprint 7 Task 7.1 captures bundle-size diff as part of manual smoke; if any chunk grows >15%, split via `dynamic()` imports per component.                                                                                                                                         |
| Daemon redeploy lag means running sandboxes emit new daemon events the server doesn't yet understand (or vice versa)                                                                       | Schema evolution in Sprint 1 is additive-only (new optional fields, new union variants). The existing daemon POSTing the old shape still parses. The new daemon POSTing extra fields is accepted by the old server (which ignores unknown fields). No coordinated deploy required. |
| Integration harness (Sprint 6) becomes flaky because it depends on recorded timing                                                                                                         | Replayer runs in "fast-forward" mode by default (consumes `wallClockMs` as an ordering hint only); realtime mode is opt-in for debugging.                                                                                                                                          |
| One mega-PR becomes unreviewable (7 sprints, ~50 tasks)                                                                                                                                    | Commits are atomic per task; reviewers can read one sprint at a time. Sprint demos give natural review checkpoints. If a reviewer insists on splitting, the sprint boundaries are the natural seams for post-hoc bisection.                                                        |
| PR #126 merges during this work and the `SILENTLY_IGNORED_ITEM_TYPES includes collabAgentToolCall` test conflicts with Sprint 2.1's inversion                                              | Sprint 7 Task 7.4 handles this; expect a trivial rebase.                                                                                                                                                                                                                           |
| Sandbox image rebuild lag: the bubblewrap fix in PR #126 requires a new image. This PR adds new daemon behavior. If neither image is rebuilt, the old daemon still runs in live sandboxes. | Document in PR description (Sprint 7 Task 7.3) that the full UX only appears on sandboxes booted from a new image; existing sandboxes degrade gracefully.                                                                                                                          |
| Strict TDD slows the implementer subagent down when the test requires fixture capture against a live sandbox                                                                               | Sprint 0 front-loads all capture, so Sprints 2–5 never need live-sandbox access during implementation.                                                                                                                                                                             |

## Rollback Plan

- **Single-shot revert:** The mega-PR is merged as a single commit (or merge commit). If post-merge production issues arise, `git revert <merge-commit>` + redeploy frontend + rebuild daemon bundle. All changes are additive to the data schema (no destructive migrations), so revert is safe from a data standpoint.
- **Per-sprint partial rollback:** Sprint boundaries are coherent enough that reverting, e.g., just Sprint 5 (UI) to fall back to generic renderers while keeping the daemon changes (Sprints 2–4) is viable. The meta-event channel (Sprint 2.8) is ignored by any UI version that doesn't subscribe to it.
- **DB rollback:** If a real migration is produced in Sprint 1.4, it MUST be reversible (Drizzle-generated down migration). If that's not feasible, the task blocks and we revisit the approach.

---

## PR structure conventions

Per user directive the deliverable is one PR, but the internal commit + review structure must keep reviewers sane:

- **One commit per task.** Conventional Commit subject lines (`test:` / `feat:` / `fix:` / `refactor:` / `chore:`), scope is the package (`shared`, `daemon`, `www`).
- **Sprint-boundary marker commits.** At each sprint boundary, a single zero-diff commit with subject `chore(plan): end of Sprint N — <name>` and a body summarizing the sprint's output. Reviewers can hit "previous / next" between those markers to review one sprint at a time.
- **PR description lists commits grouped by sprint** with direct links. Reviewers pick a sprint, scroll its commit list, file a "sprint approved" comment.
- **No squash on merge.** Merge commit preserves the sprint history; single-shot revert is still just `git revert <merge-commit>`.

## Execution order summary

1. Sprint 0 (fixtures + refs + branch) — 1–2 days
2. Sprint 1 (schema + types) — 1 day
3. Sprint 2 (Codex adapter) — 2–3 days
4. Sprint 3 (ACP adapter) — 2 days
5. Sprint 4 (Claude Code adapter) — 1–2 days
6. Sprint 5 (UI renderers) — 3–4 days
7. Sprint 6 (integration harness) — 2–3 days
8. Sprint 7 (polish + PR) — 1 day

**Total realistic wall time:** ~2 weeks of focused work. Subagent-driven-development compresses coordination but not wall clock; each sprint has serial dependencies that can't be parallelized inside the sprint.
