# User Testing

Validation surface and execution guidance for this mission.

## Validation Surface

- **Browser surface**

  - Primary tool: `agent-browser`
  - Fallback: Playwright (only when `agent-browser` is blocked)
  - Scope: delivery-loop progression UI, blocked/manual-fix visibility, terminal-state rendering, PR-link visibility, refresh behavior

- **API surface**

  - Tools: `vitest` route tests + targeted `curl`
  - Scope: daemon-event ingress, webhook ingress, scheduled-tasks cron, dispatch-ack-timeout cron

- **CLI surface**

  - Tools: `pnpm delivery-loop:local ...`
  - Scope: preflight/run/snapshot/e2e contracts, deterministic failure guardrails, diagnostics emission

- **Process surface**
  - Tools: `vitest` runtime suites
  - Scope: reducer transitions, invariants, effect processing, durable worker/relay behavior, retry/dead-letter semantics

## Validation Concurrency

Resource basis from dry run:

- CPU cores: `14`
- Total memory: ~`48.0 GiB`
- Post-exercise available memory: ~`9.61 GiB`
- Headroom policy: use `70%` of available memory

Computed conservative max concurrent validators per surface:

- Browser: `5`
- API: `5`
- CLI: `5`
- Process: `5`

Operational guidance:

- Start with `3` concurrent validators by default and scale to `5` only if host remains stable.
- Prefer grouping heavy process assertions together to avoid redundant app/service startup churn.

## Validation Readiness Notes

- Process validation path currently depends on repairing stale `delivery-loop:local run --profile fast` test references.
- Direct vitest suites for representative delivery-loop unit/integration/e2e checks are executable now.
- Real e2e validation requires repo/user inputs and reachable web URL configuration in non-development mode.
