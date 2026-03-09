# Diagnostics

## External Blockers

Treat these as infrastructure blockers unless repository code changed in the same run:

- `docker: command not found`
- Docker daemon unavailable (`Cannot connect to the Docker daemon`)
- `Cannot find module '.prisma/client'` or `@prisma/client` import failure

When these occur, report:

1. The exact failing line
2. Why this is external
3. The retry condition (Docker healthy, Prisma generated)

## Code-Related Failures

Treat as code-related when:

- Test command executes and fails on assertions or type/runtime errors
- Lint/type/test config references invalid paths
- Unit script exists but is broken

In these cases:

1. Apply fixes in the PR branch
2. Re-run the same command that failed
3. Report the delta and final status

## Suggested Commands

- Full mode preflight:
  - `skills/bonaparte-test-runner/scripts/run-tests.sh --dry-run`
- Full execution:
  - `skills/bonaparte-test-runner/scripts/run-tests.sh`
- Unit-only execution:
  - `skills/bonaparte-test-runner/scripts/run-tests.sh --mode unit`
