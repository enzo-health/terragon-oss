# Fabro Architecture Notes

## Overview

- Workflow-as-code: `.fabro` Graphviz definitions, `.toml` run config, and provider `.env` are parsed, validated, and merged before runtime, so every run starts from a deterministic graph definition (docs/core-concepts/how-fabro-works.mdx).
- Single engine, two surfaces: `fabro run` (CLI) and `fabro serve` (API). Both wire into the shared `WorkflowRunEngine` that resolves context, executes handlers, emits events, selects transitions, and checkpoints each stage (lib/crates/fabro-workflows/src/engine.rs).
- Human decisions live in explicit `hexagon` gate nodes backed by the `Interviewer` abstraction, so CLI and web UI share the same pause/resume contract (lib/crates/fabro-workflows/src/handler/human.rs, docs/workflows/human-in-the-loop.mdx).

## Workflow Runtime

- Definition → Stage: Nodes are author-time constructs, stages are their runtime executions. Loops are repeated stage visits governed by `max_visits`, with independent context snapshots per visit (docs/workflows/stages-and-nodes.mdx, lib/crates/fabro-workflows/src/handler/mod.rs).
- Handler registry dispatches per-node logic (agent/prompt/command/human/wait/parallel/fan_in/manager_loop) and returns typed outcomes; outcomes feed deterministic transition selection (`select_edge`) with explicit precedence (condition match → preferred label → suggested next → unconditional, falling back to weights) (docs/workflows/transitions.mdx, lib/crates/fabro-workflows/src/handler/mod.rs).
- Runtime context is tied to a shared key/value store (`Context`/`ContextKey`) plus checkpoint snapshots; stage outcomes update context, which informs future edges and guards on human input (lib/crates/fabro-workflows/src/context).
- Failures flow through layered safeguards: per-node retries, provider failover, loop/circuit breakers tied to failure signatures, watchdogs, and goal gates before aborting (docs/execution/failures.mdx).
- Handlers emit typed `Outcome` structs containing success/failure metadata, retry/state deltas, progress messages, and tag recommendations; the engine turns those into `WorkflowRunEvent`s that drive SSE/logging consumers (lib/crates/fabro-workflows/src/outcome.rs, src/event.rs).

## Scheduling and Concurrency

- API server maintains a FIFO run queue (`Queued` → `Starting` → `Running`) with a configurable concurrency cap; the scheduler owns the admission loop while the engine owns per-run transitions (lib/crates/fabro-api/src/server.rs, docs/reference/architecture.mdx).
- Event bus emits structured lifecycle, stage, edge, checkpoint, and sandbox logs; CLI writes `progress.jsonl`/`live.json`, API streams via SSE and REST notifications (lib/crates/fabro-workflows/src/event.rs, lib/crates/fabro-cli/src/commands/run.rs, lib/crates/fabro-api/src/server.rs).
- `BackendRouter` selects between CLI-local providers and API-hosted agents, letting the same workflow graph run with different toolchains / credential sets; runs pass the selected backend through the context so handler logic can reuse the proper interfaces (lib/crates/fabro-workflows/src/backend/cli.rs, src/backend/api.rs).

## Persistence and Checkpointing

- Each stage writes a durable checkpoint (`checkpoint.json`) before side effects, capturing `next_node_id`, context, retries, history, and failure signatures; Git metadata branches (`fabro/run/{id}`, `fabro/meta/{id}`) mirror run state for auditing, with trailer links managed in `git.rs` and `fabro-git-storage` (lib/crates/fabro-workflows/src/checkpoint.rs, lib/crates/fabro-git-storage/src/trailerlink.rs, docs/execution/checkpoints.mdx).
- Run directories contain manifests, progress logs, conclusions, and artifacts; the manifest/replay lookups enable resume, rewind, and fork operations (lib/crates/fabro-workflows/src/manifest.rs, lib/crates/fabro-workflows/src/run_lookup.rs, docs/reference/run-directory.mdx).
- A SQLite-backed `fabro-db` schema exists, but the current API lifecycle keeps in-memory `AppState.runs` (lib/crates/fabro-db, lib/crates/fabro-api/src/server.rs).
- Metadata helpers (`RunLookup`, `RunStatus`) surface latest checkpoint IDs, current status, and tag history so CLI/server can advertise run health and resume cleanly after client disconnects (lib/crates/fabro-workflows/src/run_status.rs, src/run_lookup.rs).

## Run Lifecycle Details

- Runs move through `Queued` → `Starting` → `Running` → `Paused` → `Completed/Failed`; API endpoints support `/runs/{id}/resume`, `/pause`, `/cancel`, mirroring CLI flags and enabling deterministic reruns (lib/crates/fabro-api/src/server.rs, lib/crates/fabro-cli/src/commands/run.rs, docs/api-reference/fabro-api.yaml).
- The scheduler increments `run_seq`, enforces `max_concurrent_runs`, and pauses FIFO admission when concurrency caps are hit; existing runs continue while new admissions wait, keeping throughput predictable (lib/crates/fabro-api/src/server.rs).

## Human Gates & Sub-agents

- Human gates capture context fields (`human.gate.selected`, `label`, `text`) and expose decision metadata so downstream routing can branch on answers; they enforce timeout/default behaviors and admit accelerator labels/freeform exits (docs/workflows/human-in-the-loop.mdx, lib/crates/fabro-workflows/src/handler/human.rs).
- Sub-agents provide isolated tool loops for portions of a run; the API can spawn child sessions, forward lifecycle events, and merge outcomes with depth limits, mirroring the parent engine’s context (docs/agents/subagents).

## Observability & Retrospectives

- Canonical event stream powers real-time UIs, SSE, and logging; each event carries reason codes that make transition history queryable (lib/crates/fabro-workflows/src/event.rs, docs/execution/observability.mdx).
- Retrospectives derive from the same structured events and can optionally run an AI narrative agent to summarize runs, yielding deterministically reproducible insights (docs/execution/retros.mdx, lib/crates/fabro-retro/src/retro.rs).

## Lessons for Delivery Loop v2

1. Keep transitions, context, and work scheduling separate: `reduceSignalToEvent`/`reduceWorkflow` should stay the single transition boundary, while `resolveWorkItems` stays deterministic and idempotent (apps/www/src/server-lib/delivery-loop/coordinator/reduce-signals.ts, schedule-work.ts).
2. Model retries/stages explicitly: track `workflowId+version+dispatch` entries per attempt so partial progress and redispatches are audit trails rather than opaque counters (packages/shared/src/delivery-loop/domain/workflow.ts).
3. Treat human interventions as gated states with allowed actions and optional metadata instead of ad hoc booleans (apps/www/src/server-lib/delivery-loop/adapters/ingress/human-interventions.ts, transitions.ts).
4. Upgrade observability/retros to use a single event stream that feeds UI, SSE, and replay logic (packages/shared/src/delivery-loop/store/event-store.ts, runtime-status-store.ts, replay-store.ts).
5. Embrace checkpoint-first semantics: persist workflow snapshots and queue state before executing side effects so resumes/rewinds are deterministic (apps/www/src/server-lib/delivery-loop/coordinator/tick.ts, ack-lifecycle.ts).

## References

- Fabro docs: `docs/core-concepts/how-fabro-works.mdx`, `docs/reference/architecture.mdx`, `docs/workflows/stages-and-nodes.mdx`, `docs/workflows/transitions.mdx`, `docs/workflows/human-in-the-loop.mdx`, `docs/execution/checkpoints.mdx`, `docs/execution/failures.mdx`, `docs/execution/observability.mdx`, `docs/agents/subagents`.
- Fabro repo: `lib/crates/fabro-workflows/src/engine.rs`, `handler/*.rs`, `context/*.rs`, `checkpoint.rs`, `git.rs`, `event.rs`, `lib/crates/fabro-cli/src/commands/run.rs`, `lib/crates/fabro-api/src/server.rs`, `lib/crates/fabro-db`.
