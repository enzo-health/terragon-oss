# Chat-UI Protocol Gaps: Upstream Reference SHAs

## Rationale

We pin exact upstream SHAs and package versions so that (1) future pull requests can explicitly show when upstream specs diverge from what we built against, (2) reviewers and maintainers can cross-reference protocol implementations against a frozen, immutable source-of-truth, and (3) fixture capture and test assertion remain deterministic across time. When upstream publishes a breaking change, the pin update becomes a visible commit in the PR history, making the cost of porting explicit.

## OpenAI Codex app-server Protocol

- **Repo:** https://github.com/openai/codex
- **SHA:** `d013576f8bd8f03144881a3756332e3e1079283c` (head of `main` branch as of 2026-04-14)
- **Browse canonical source:** https://github.com/openai/codex/tree/d013576f8bd8f03144881a3756332e3e1079283c/codex-rs/app-server-protocol/src/protocol
- **Use:** Defines `ThreadItem` enum variants and notification method names (`common.rs`, `v2.rs`). Referenced in daemon adapter to map Codex events into Terragon message parts.

## Zed Industries Agent Client Protocol (ACP)

- **Repo:** https://github.com/zed-industries/agent-client-protocol
- **SHA:** `d212761dd4555d0140fac29e5437256e90ec7997` (head of `main` branch as of 2026-04-14)
- **Browse canonical source:** https://github.com/zed-industries/agent-client-protocol/tree/d212761dd4555d0140fac29e5437256e90ec7997
- **Use:** Defines `sessionUpdate` content-block discriminants and Zed's reference TypeScript/Rust types. Referenced in daemon adapter to map ACP payloads into message parts.

## Anthropic Claude Code CLI

- **Package:** `@anthropic-ai/claude-code` on npm
- **Version:** `2.1.107` (pinned in `packages/sandbox-image/src/dockerfile-template.ts`)
- **Registry:** https://www.npmjs.com/package/@anthropic-ai/claude-code/v/2.1.107
- **Use:** Claude Code runs in Terragon sandboxes and emits `stream-json` events. We parse system init, message deltas, and content-block deltas from its stdout.

## How to Refresh

When upstream repositories publish changes and you need to re-verify this doc against current heads:

1. **Codex:** `gh api repos/openai/codex/commits/main --jq '.sha'` — compare result to pinned SHA above.
2. **ACP:** `gh api repos/zed-industries/agent-client-protocol/commits/main --jq '.sha'` — compare result to pinned SHA above.
3. **Claude Code:** `npm view @anthropic-ai/claude-code@latest version` — compare result to pinned version above.
4. If any pin has drifted, update it in this file, pull the upstream source, review breaking changes in the relevant spec, and file an issue if porting is required.
5. Update this doc and commit with message `docs(plan): refresh upstream spec pins` if any divergence is found.
