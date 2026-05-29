# Residual Review Findings

Source review context: LFG autofix review for `docs/plans/2026-05-29-001-fix-codex-app-server-server-requests-plan.md` on branch `codex/codex-app-server-requests`.

No durable tracker sink was available before PR creation: GitHub auth succeeded, but GitHub Issues are disabled for `enzo-health/terragon-oss`, and no open PR existed yet.

## Residual Review Findings

- P2, `packages/daemon/src/daemon.ts:1319`, production `CodexAppServerManager` construction does not yet provide a real `refreshChatGptAuthTokens` callback. The manager now handles and bounds `account/chatgptAuthTokens/refresh`, but live credential refresh still needs the deferred secure run-context/internal-token endpoint before long-running ChatGPT OAuth sessions can refresh successfully.
- P2, `packages/daemon/src/codex-app-server.ts:1899`, future refresh plumbing must bind refresh authorization to the active daemon run context instead of trusting app-server-supplied request params. The current diff has no production refresh handler, so this is a deferred confused-deputy risk for the follow-up credential endpoint work.
