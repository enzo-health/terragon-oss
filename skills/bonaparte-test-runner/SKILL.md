---
name: bonaparte-test-runner
description: Run tests safely in the Bonaparte repository when Vitest is blocked by missing Docker, database containers, or missing generated Prisma client. Use this when asked to run Bonaparte tests, triage Vitest infrastructure failures, or choose between full-suite and unit-only execution paths.
---

# Bonaparte Test Runner

## Overview

Run Bonaparte tests with a preflight-first workflow so Codex does not waste time on known infrastructure blockers.

## Workflow

1. Run the bundled preflight script first:

```bash
skills/bonaparte-test-runner/scripts/run-tests.sh --dry-run
```

2. If preflight reports full mode is available, run the same script without `--dry-run`:

```bash
skills/bonaparte-test-runner/scripts/run-tests.sh
```

3. If preflight reports full mode is blocked but a unit script exists, run:

```bash
skills/bonaparte-test-runner/scripts/run-tests.sh --mode unit
```

4. If preflight reports blockers and no unit path, report the blocker clearly and stop. Do not claim tests were executed.

## Execution Rules

- Prefer the bundled script over ad-hoc Vitest commands.
- Preserve exact stderr lines for Docker and Prisma failures in your status update.
- If the script exits with blocker status, document that as external infrastructure unless repository code changed.
- If a unit-only script succeeds while full mode is blocked, state that result explicitly as partial coverage.

## Inputs

- `--mode auto|full|unit`: Select execution mode.
- `--dry-run`: Print selected mode and commands without executing tests.
- `--repo <path>`: Override repository path (default: current directory).
- `--full-command "<cmd>"`: Override full-suite command.
- `--unit-command "<cmd>"`: Override unit command.

## Output Contract

Always provide:

1. Selected mode (`full`, `unit`, or `blocked`)
2. Why that mode was selected
3. Exact command executed
4. Outcome (pass/fail/blocked)

For blocker handling patterns, read `references/diagnostics.md`.
