# AGENTS.md

## Project Overview

**Terragon** - An AI-powered coding assistant platform that allows users to run coding agents in parallel inside remote sandboxes. This allows users to do multiple tasks concurrently and asynchronously. The remote sandboxes are full development environments that allow the coding agents to make edits, run tests, verify changes and put up commit and PRs.

## Repository Structure

- **Monorepo**: Uses pnpm workspace (v10.14.0) with multiple apps and packages
- **Frontend**: Next.js 15.4.5 app (`apps/www`) with React 19.1.0
- **Documentation**: Fumadocs-based documentation site (`apps/docs`)
- **WebSocket Service**: PartyKit-based real-time service (`apps/broadcast`)
- **CLI Tool**: Interactive CLI application (`apps/cli`) for pulling threads and creating tasks
- **Agent Daemon**: A node js script we run on all sandboxes to coordinate the coding agent
- **Shared Packages**: Core libraries, database models, and utilities (`packages/`)
- **Status Microsite**: Anthropic uptime microsite (`apps/isanthropicdown`)

## Key Commands

### Development

```bash
# Run all development services concurrently (frontend, websocket, daemon, docker)
pnpm dev

# TypeScript watch mode for all services
pnpm tsc-watch
```

`pnpm dev` command does the following:

- Starts up the docker containers
- Starts apps/www (our nextjs frontend)
- Starts apps/docs (our documentation site)
- Starts apps/broadcast (our realtime service to notify clients of updates)
- Builds daemon & bundled which is the script we run on remote sandboxes
- Builds and starts mcp-server for follow-up task suggestions
- Starts an ngrok tunnel. The daemon on remote sandboxes need to ping our web frontend with updates. In development, we use an ngrok tunnel to expose the development server to the public internet for this usecase.
- Starts our cron jobs. We use vercel cron jobs in production and this mimics that in development using the vercel-cron package.
- Starts the CLI tool in development mode

### Testing & Quality

```bash
# Run tests (www/app)
pnpm -C apps/www test
pnpm -C packages/shared test
pnpm -C packages/daemon test
pnpm -C packages/sandbox test

# TypeScript type checking
pnpm tsc-check
```

### Database (Drizzle ORM)

If you make a change to the db schema, you need to run the following command to push the schema to the development db.

This happens automatically for tests environments and happens automatically in production using a github action when code lands on main.

```bash
# Push schema to dev database
pnpm -C packages/shared drizzle-kit-push-dev

# View database in Drizzle Studio
pnpm -C packages/shared drizzle-kit-studio-dev
```

### CLI Tool

```bash
# Install CLI locally for development
pnpm install-cli:dev

# Or run from apps/cli
pnpm -C apps/cli install:dev

# Uninstall CLI
pnpm -C apps/cli uninstall:dev
```

## Technology Stack

- **Framework**: Next.js 15.4.5 (App Router) with React 19.1.0
- **Styling**: Tailwind CSS v4
- **State Management**: Jotai, React Query (Tanstack Query)
- **Database**: Drizzle ORM with PostgreSQL
- **Auth**: Better Auth with GitHub OAuth, Claude OAuth integration
- **AI**: Anthropic Claude SDK, AI SDK, OpenAI (commit messages and Codex integration). Coding-agent providers are Claude and Codex only.
- **UI Components**: Radix UI primitives with shadcn/ui
- **Testing**: Vitest
- **Real-time**: PartySocket for WebSocket communication
- **Sandbox Providers**: E2B, Docker (for testing), Daytona
- **Runtime**: PartyKit (real-time infrastructure)
- **UI Development**: Ladle for component development
- **CLI**: Ink for interactive terminal UI, ORPC for type-safe API communication
- **Rich Text**: TipTap editor with slash commands
- **Email**: React Email for transactional emails
- **Deployment**: Vercel (frontend), PartyKit (WebSocket)

### Key Dependencies

- **Claude Integration**: `@anthropic-ai/sdk` (v0.52.0)
- **Sandbox Providers**: `@e2b/code-interpreter` (v1.2.0-beta.4)
- **GitHub**: Octokit (v5.0.2) for GitHub API
- **Database**: `drizzle-orm` (v0.43.1) with PostgreSQL
- **Rate Limiting**: `@upstash/ratelimit` with Redis
- **File Storage**: Cloudflare R2 integration
- **Real-time**: PartyKit (v0.0.110)
- **RPC**: `@orpc/server` (v1.6.0) for type-safe CLI-backend communication
- **Rich Text**: TipTap (v2.14.0) for advanced editor features
- **Email**: React Email for transactional email templates
- **Sandbox: Daytona**: `@daytonaio/sdk` (v0.25.5)

## Feature Flags

### Creating a Feature Flag

1. **Define the feature flag** in `packages/shared/src/model/feature-flags-definitions.ts`:

   ```typescript
   export const featureFlagsDefinitions = {
     myNewFeature: {
       defaultValue: false,
       description: "Clear description of what this feature flag enables",
     },
     // ... other flags
   } satisfies Record<string, FeatureFlagDefinition>;
   ```

2. **Use the feature flag** in React components with the `useFeatureFlag` hook:

   ```typescript
   import { useFeatureFlag } from "@/hooks/use-feature-flag";

   const MyComponent = () => {
     const isMyFeatureEnabled = useFeatureFlag("myNewFeature");

     if (isMyFeatureEnabled) {
       // Feature-specific code
     }
   };
   ```

3. **Configure feature flags** via the admin page:
   - Global settings affect all users by default
   - Per-user overrides can be set for specific users
   - The defaultValue in the definition is used when no override exists

### Deleting a Feature Flag

1. Remove all usages of the feature flag in code
2. Delete the feature flag definition from `feature-flags-definitions.ts`
3. Remove the feature flag configuration from the admin page

## Architecture Components

### Core Agent System (`apps/www/src/agent/`)

- **Sandbox Orchestration**: Multi-provider sandbox management (E2B, Docker)
- **Claude Integration**: Message processing and tool execution
- **Daemon System**: Autonomous Node.js agent running in sandboxes
- **Resource Management**: Hibernation and session lifecycle management

### Chat System (`apps/www/src/components/chat/`)

- **Real-time UI**: React-based chat interface with message streaming
- **Tool Visualization**: Custom components for bash, file operations, git diff, web search/fetch, todos
- **Message Processing**: Structured Claude message handling with tool calls
- **Status Tracking**: Thread status, sandbox state, and real-time updates
- **Rich Text Editor**: TipTap-based prompt box with mentions, image attachments, and slash commands
- **Follow-up Tasks**: Suggest follow-up task tool integration
- **Copy Features**: Copy buttons for chat messages and code blocks
- **Scroll Navigation**: Floating scroll-to-bottom button with delayed visibility
- **Rich Part Renderers**: The live transcript renders through `assistant-ui/native-thread.tsx` (leaves driven by `native-thread-utils.ts` adapters) plus the vendored nauval components in `components/ai/*`. The legacy `message-part.tsx` / `tool-part.tsx` / `PART_REGISTRY` / `TOOL_DISPATCH` / `ChatMessage` dispatch tree and the AG-UI aggregator island have been removed; do not reintroduce them.
- **Meta Event Chips** (`meta-chips/`): Header chips subscribed to the daemon's `ThreadMetaEvent` channel — token usage, rate limits, model re-routing, MCP server health
- **Integration Harness** (`apps/www/test/integration/`): Replay-based E2E tests. The recorder CLI (`pnpm recorder`) captures live `daemon-event` POST traffic to JSONL; the replayer drives recordings through the real Next.js API route + chat UI in-process for deterministic CI assertions without a live sandbox

### Chat Layer Architecture Invariants

The chat layer is in the middle of a multi-phase consolidation onto `@assistant-ui/react`. The consolidated plan of record is `docs/plans/2026-04-27-refactor-chat-layer-consolidated-plan.md` (predecessor plans are archived under `docs/plans/archive/`). The invariants below reflect what is already true on `main` after recent refactors — do not regress them. Anything not listed here (full assistant-ui runtime ownership, makeAssistantToolUI cascade, REASONING\_\* events, ActivityMessage adoption) is still in-flight and tracked in the consolidated plan. Runtime write routing for existing-thread appends has landed: `POST /api/ag-ui/[threadId]` parses AG-UI command bodies through `handleAgUiPostCommand()`, dispatches appends through `dispatchFollowUpFromAppend()` → `followUpInternal()`, and falls through to the GET SSE path for bodyless, replay, and resume POSTs. Runtime cancel routes through the AG-UI cancel endpoint → `cancelThreadFromAgUiInput()` → `stopThreadInternal()`. AG-UI is transport; Terragon's follow-up/stop pipeline remains the DB writer.

- **Transcript rendering is leaf components driven by adapters, not a dispatch table.** The live transcript renders via `apps/www/src/components/chat/assistant-ui/native-thread.tsx`, whose message/tool/reasoning leaves are fed by pure adapter functions in `native-thread-utils.ts` (`toolGroupViewProps`, `reasoningViewProps`, `streamingView`, etc.) and render into the vendored nauval components under `apps/www/src/components/ai/*` (`message`, `tool`, `reasoning`, `callout`, ...). The legacy dispatch tree — `message-part.tsx`, `tool-part.tsx`, `parts/part-registry.ts` (`PART_REGISTRY`), `tools/tool-registry.ts` (`TOOL_DISPATCH`), and the `ChatMessage` component — plus the AG-UI aggregator island were all DELETED. Do not reintroduce them or any switch/table that dispatches over part/tool names; extend the adapters and leaf components instead.
- **Queued user messages and inline errors render through dedicated leaves.** Queued (not-yet-sent) user parts render via `apps/www/src/components/promptbox/queued-user-parts.tsx` (`QueuedUserPart`), an exhaustive switch over the closed user-part union calling the standalone `TextPart`/`ImagePart`/`RichTextPart`/`PdfPart`/`TextFilePart` renderers directly. Item-level `DBErrorPart` (e.g. a Codex `error` item) renders via the `NativeError` `DataMessagePartComponent` registered as the `terragon.error` data part in `native-thread.tsx`, which draws the nauval `Callout`.
- **assistant-ui dependencies are pinned to exact versions.** `@assistant-ui/react` is pinned to `0.12.24`. `@assistant-ui/react-ag-ui`, `@ag-ui/client`, and `@ag-ui/core` are all pinned to exact pre-1.0 versions. Both libraries have documented protocol churn between minor versions; do not switch any of these to caret (`^`) or tilde (`~`) ranges. Upgrades must be deliberate and tested end-to-end against the integration harness. Beyond pinning, `@assistant-ui/react-ag-ui@0.0.26` is locally PATCHED via `patches/@assistant-ui__react-ag-ui@0.0.26.patch` (registered in the root `package.json` under `pnpm.patchedDependencies`). The patch adds four options the stock package lacks — `externalMessagesStrategy`, `historyLoadKey`, `waitForInitialLoad`, and `targetMessageId` routing — that Terragon's transcript hydration and streaming depend on. An upgrade must deliberately port the patch forward; see `patches/README.md`.
- **Justified divergences from assistant-ui (do NOT propose migrating these):**
  - `apps/www/src/components/promptbox/use-promptbox.tsx` — TipTap is the input slot. Submission runs through `routeComposerSubmit()` → `useThreadRuntime().append()`, which routes via the AG-UI POST adapter to the `followUp()` server action. Active-run queueing is owned by `routeComposerSubmit()` plus the chat prompt-box queued-message state; do not reintroduce a separate composer queue hook. Slash commands, mentions, drafts, transcription, and attachments live inside the TipTap slot. Wrapping the composer in `ComposerPrimitive.Root` (per `docs/plans/2026-04-30-runtime-owns-writes-adr.md`) is intended direction and is NOT landed — `ComposerPrimitive` appears nowhere in the tree today. Do not propose ripping out TipTap; do propose moving any remaining direct `followUp()` calls from the composer onto `runtime.append`.
  - `apps/www/src/components/ai-elements/markdown-renderer.tsx` — streamdown-based renderer. `@assistant-ui/react-markdown` does not expose `parseIncompleteMarkdown`, so swapping it in would regress streaming-token rendering UX.

### Database Schema (`packages/shared/src/db/`)

- **Messages** (`db-message.ts`): JSONB-stored `DBMessage` discriminated union. Top-level variants include `DBUserMessage`, `DBAgentMessage`, `DBToolCall`, `DBToolResult`, `DBSystemMessage`, `DBDelegationMessage` (sub-agent delegation), and others. Agent message `parts` accept text, thinking, image, audio, resource-link, terminal, diff, plan, and auto-approval-review variants. `DBToolCall` carries lifecycle fields (`startedAt`, `completedAt`, `status`, `progressChunks`, `mcpMetadata`). The schema version is exported as `DB_MESSAGE_SCHEMA_VERSION`. Read-side parsers must tolerate unknown variants — extend the union before changing read code.
- **Threads**: Chat sessions with sandbox and GitHub integration, parent thread relationships, task sharing
- **Users**: Authentication, settings, API key management, roles and permissions
- **Environments**: User-repository combinations with environment variables and MCP config
- **GitHub PRs**: Pull request tracking and automated workflows
- **Claude OAuth**: Token storage for Claude subscription integration
- **Thread Read Status**: Unread/read tracking for threads (marked read on archive)
- **User Flags**: Feature flags and user preferences
- **Feedback**: User feedback collection system
- **Waitlist**: Early access signup management
- **Allowed Signups**: Whitelist for user registration
- **Access Codes**: Controlled signup system with optional email binding and expiration
- **Linear Accounts**: Linear user to Terragon user account linking per organization
- **Linear Settings**: Per-user Linear integration defaults (default repo, model)
- **Linear Installation**: Workspace-level OAuth token storage for the Linear Agent (`linearInstallation` table). One record per Linear workspace. Stores encrypted access/refresh tokens, expiry, and install metadata. Nullable `refreshTokenEncrypted` triggers reinstall prompt in Settings UI.

### GitHub Integration (`apps/www/src/server-actions/`)

- **Automated Workflows**: Branch creation, commits, and PR management
- **AI-Generated Content**: Commit messages and PR descriptions using OpenAI
- **Status Synchronization**: Real-time PR status polling and updates
- **GitHub Checks**: Webhook handlers for tracking check status
- **PR Management**: Auto-update titles/descriptions, use thread's base branch, user attribution
- **Auto-recovery**: Automatic fix for git commit/push failures with follow-up queuing

## Environment Setup

### Configuration Files

- **Environment**: `.env.example` files in apps/www, apps/broadcast, packages
- **Development**: Docker Compose with PostgreSQL 16, Redis 7
- **Deployment**: Vercel (frontend), PartyKit (WebSocket), sandbox providers
- **TypeScript**: Shared config via `@terragon/tsconfig`

### Key Environment Variables

- **AI Services**: Anthropic Claude, OpenAI, E2B API keys
- **Infrastructure**: Database URL, Redis, Cloudflare R2 storage
- **Auth**: GitHub OAuth credentials, internal shared secrets
- **Development**: ngrok for local tunnel, sandbox provider configs
- **Sandbox Providers**: `DAYTONA_API_KEY` for Daytona provider
- **Optional Providers**: OpenAI OAuth/ChatGPT auth.json
- **Linear Agent**: `LINEAR_WEBHOOK_SECRET`, `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` (OAuth app credentials for the Linear Agent).

## Package Structure

### Core Applications

- **`apps/www`**: Main Next.js frontend application
- **`apps/broadcast`**: PartyKit WebSocket service for real-time features
- **`apps/docs`**: Fumadocs-based documentation site
- **`apps/cli`**: Terry CLI tool for pulling threads (uses Ink for terminal UI)
- **`apps/isanthropicdown`**: Status microsite (Vite + Cloudflare Workers)

### Shared Packages

- **`@terragon/shared`**: Database models, schemas, and core utilities
- **`@terragon/daemon`**: Sandbox agent runtime and communication
- **`@terragon/bundled`**: Bundled scripts for deployment (includes daemon, mcp-server)
- **`@terragon/env`**: Environment configuration management
- **`@terragon/r2`**: Cloudflare R2 storage integration
- **`@terragon/dev-env`**: Docker development environment
- **`@terragon/tsconfig`**: Shared TypeScript configuration
- **`@terragon/mcp-server`**: Model Context Protocol server for follow-up task suggestions
- **`@terragon/debug-scripts`**: Debugging utilities for E2B sandboxes (SSH, connect, create, resume)
- **`@terragon/cli-api-contract`**: ORPC-based CLI API contract definitions
- **`@terragon/transactional`**: React Email-based transactional email templates
- **`@terragon/sandbox`**: Sandbox abstraction across multiple providers (E2B, Docker, Daytona)
- **`@terragon/sandbox-image`**: Sandbox image specific code to create template images for sandbox providers
- **`@terragon/one-time-token-signin`**: Better Auth plugin for magic-link/one-time token sign-in

## Important Notes

- **Package Manager**: pnpm (v10.14.0) with workspace support
- **TypeScript**: Path aliases `@/*` → `./src/*` in Next.js app
- **Monorepo**: Workspace dependencies with `workspace:*` references

### Environment Configuration

- **Development Database**: PostgreSQL on port 5432, Redis on port 6379
- **Test Database**: PostgreSQL on port 15432, Redis on port 16379
- **Environment Files**: `.env.development.local` for local development
- **Vitest Configuration**: Test environment variables are pre-configured in `vitest.config.ts`

## Troubleshooting

### Common Development Issues

- **Docker containers not starting**: Check Docker is running and ports 5432, 6379 are free
- **TypeScript errors after pulling**: Run `pnpm install` to sync dependencies
- **Database schema out of sync**: Run `pnpm -C packages/shared drizzle-kit-push-dev`
- **Sandbox connection issues**: Verify E2B API keys are set correctly
- **Ngrok tunnel issues**: Check `NGROK_AUTH_TOKEN` and `NGROK_DOMAIN` in `.env.development.local`
- **CLI not found**: Run `pnpm install-cli:dev` to install the Terry CLI locally

### Debug Scripts

```bash
# SSH into an E2B sandbox
pnpm -C packages/debug-scripts e2b-ssh <sandbox-id>
```

## Recent Features

- **Claude OAuth**: Direct Claude subscription integration for API access
- **Follow-up Queue**: Agent queue for processing follow-up tasks
- **Auto-close Draft PRs**: Setting to automatically close draft PRs on archive
- **Interactive CLI**: Pull command with thread selection interface, create task command
- **MCP Server**: Model Context Protocol server for follow-up task suggestions
- **Survey System**: User feedback collection via survey page
- **Task Sharing**: Read-only task sharing with visibility controls
- **Access Codes**: Controlled signup system with email binding and expiration
- **Slash Commands**: TipTap-based slash commands in chat prompt box
- **Active Sandboxes Admin**: Admin page for monitoring active sandboxes
- **Onboarding Emails**: Automated welcome emails for new users
- **Redo Task**: Button to restart tasks from chat header
- **Fast Resume**: Optimized sandbox setup for quicker thread resumption
- **Admin UI Enhancements**: Sortable columns, filters, thread/user counts, invite functionality
- **Automations**: Scheduled and PR-triggered automations with cron validation, next-run calculation, and admin visibility
- **Daytona Provider**: Optional Daytona sandbox provider behind feature flag with `DAYTONA_API_KEY`
- **MCP Permission Prompt**: Internal MCP tool to handle permission requests in plan mode
- **Credentials UI**: OpenAI OAuth and ChatGPT auth.json support
- **CLI Additions**: `auth`, `list`, and `mcp` commands, plus `--resume` option for `pull`
- **Linear Agent**: Upgraded Linear integration to a first-class Linear Agent with OAuth 2.0 (`actor=app`), native `AgentSessionEvent` webhooks, agent activities streamed to Linear in real time, automatic repository suggestions, token refresh with DB-level concurrency guard, and separate "disconnect account" vs "uninstall workspace" actions in Settings

## Release Notes

When adding new entries to release notes (`apps/docs/content/docs/resources/release-notes.mdx`):

1. Follow the template and guidelines in `apps/docs/RELEASE_NOTES_TEMPLATE.md`
2. **CRITICAL**: After adding a new release notes entry, bump the `RELEASE_NOTES_VERSION` constant in `apps/www/src/lib/constants.ts` by incrementing it by 1
3. This version bump triggers the release notes badge to appear for users, notifying them of new updates
