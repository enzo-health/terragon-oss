# Mobile UI testing — Ladle component captures (375px)

Date: 2026-05-25
Tool: Ladle (`pnpm storybook` → `ladle serve` on :61000) driven via the chrome-devtools MCP at iPhone SE width (375×667).

## Why Ladle, not the real app

The full app needs a running authenticated server (Next dev + Postgres/Redis + GitHub/Claude OAuth) that this worktree has no env for. Ladle renders the chat components in isolation with no DB/auth, so it's the only live-render path available here. It exercises real component CSS at a real mobile width — which is exactly what the responsiveness fixes touch.

## Captured

| File                           | Component                | Result at 375px                                                                                                                    |
| ------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `01-diff-part-375.png`         | Diff header (Applied)    | Fits; file path + "Applied" badge on one row, no overflow                                                                          |
| `02-diff-part-pending-375.png` | Diff header (Pending)    | Fits; path + Pending + Accept + Reject on one row. Accept/Reject are small (~22–28px) — confirms the deferred touch-target finding |
| `03-terminal-375.png`          | Terminal output (inline) | Fits; output wraps inside the dark panel, title clips cleanly, no page overflow                                                    |
| `05-promptbox-buttons-375.png` | Send/mic button states   | Render fine but ~32px — visual confirmation of the deferred 44px touch-target finding                                              |
| `06-chat-message-375.png`      | User message bubble      | Right-aligned `max-w-[90%]`, numbered list wraps inside the bubble, no overflow                                                    |

## Could NOT verify here

- **`04-promptbox-simple-375.png` rendered blank** — the composer story needs app providers Ladle doesn't supply. The composer is the W3 surface, and its real risk (on-screen keyboard occlusion via VisualViewport) only reproduces on a device anyway.
- **`chat-ui-layout` flex-blowout fix (`min-w-0`)** can't be exercised in Ladle — it's a layout container, not a story. Needs the full app.
- **Videos** — the chrome-devtools MCP exposes screenshots and traces, not video recording. No mp4 produced.
- **usePlatform first-paint flash** — needs the real SSR app to observe.

## Real app (authenticated, 375px iPhone emulation)

Ran the actual Next dev server (Postgres/Redis dev containers already up) and authenticated via the built-in **dev login** (`ENABLE_DEV_LOGIN=true` → `GET /api/auth/sign-in/dev-login`). Boot needed dummy `GITHUB_*` env (validation-only) + `LOCALHOST_PUBLIC_DOMAIN=localhost:3000`; none persisted to disk.

| File                       | Surface             | Result at 375px                                                                                                                                                                                                                        |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-01-login-375.png`     | Login               | Clean; centered card, full-width GitHub button. Bonus: the PWA `InstallPrompt` toast fires here                                                                                                                                        |
| `app-02-dashboard-375.png` | Dashboard task list | Fits; titles truncate, repo + gear per row, no overflow                                                                                                                                                                                |
| `app-03-thread-iphone.png` | Chat / thread view  | Header (toggle, title, PR pill, `...`, mobile panel icon), messages, Queued, and composer all fit. **`scrollWidth === 375`, zero horizontal overflow** — validates the `min-w-0` fix and the chat-header CSS migration on the real app |

The composer (blank in Ladle) renders correctly here. Still visibly confirmed as deferred: small touch targets on message-action and composer buttons.

## Takeaway

The component-level fixes that Ladle _can_ show (diff, terminal, message bubble) render correctly at 375px with no horizontal overflow. The two things this run visually confirmed as still-open are both already in the deferred list: small touch targets and the composer keyboard behaviour. A real device-matrix pass still needs a running, authenticated dev environment.
