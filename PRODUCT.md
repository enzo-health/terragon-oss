# Product

## Register

product

## Users

Developers running multiple AI coding agents (Claude, Codex, Gemini, Amp) concurrently in parallel remote sandboxes. Their context is task-driven: reviewing diffs, managing PRs, monitoring agent state, dispatching follow-up work. They are fluent in Linear, Notion, Raycast, and the modern developer-tool category. Their job-to-be-done is parallel coordination of long-running AI work; the tool either stays out of their way or fails them.

## Product Purpose

Terragon is an AI-powered coding assistant platform that runs coding agents in parallel inside remote sandboxes. Users dispatch tasks (PRs, refactors, bug fixes), watch multiple agents work concurrently, and review/merge their output. Success means the tool disappears into the work: agents finish faster than the user could orchestrate manually, and the interface never competes with the agents' output for attention.

## Brand Personality

**Developer-trusty, dense, no-nonsense.** Linear-flavored rigor inside an Anthropic-family warm-cream aesthetic.

The interface inherits the warm cream + serif-accent visual family from Anthropic, but its working voice is the rigorous internal-tool ergonomics of Linear and Notion. Editorial Cormorant moments are _cited inheritance_ (dashboard greeting, login hero, wordmark), not the brand voice. Everywhere else: Geist, hairlines, density.

Emotional goals: the tool feels trustworthy, considered, fast. Users should never feel they're being marketed to or performed for.

References to feel adjacent to:

- **Linear**: rigor, density, restraint. The internal-tool benchmark for keyboard-first developer flow.
- **Anthropic.com**: warm cream, editorial-serif voice, Geist + serif accent. The visual family this codebase cites.
- **Notion / Things 3**: editorial-ergonomic, hairline-driven, content-first.

## Anti-references

What this should NOT look like:

- **SaaS dashboard cliché**: gradient hero metrics, big-number/small-label cards, indigo accent defaults, identical card grids, "Your Stats This Week" templates. The default agent-platform competitor look.
- **AI cyberpunk aesthetic**: neon-on-black, glowing orbs, glassmorphism, generative-art chrome, "futuristic" gradients. The lazy "AI tool" stereotype.
- **Marketing-fluid typography in dense UI**: `clamp()` heading sizes, scroll-driven type animations, fluid spacing in app surfaces. Marketing-page idioms misapplied to internal tools.

## Design Principles

1. **Restraint over flourish.** Internal tool: every flourish has to earn its place. No hero metrics, no decorative motion, no editorial scale by reflex. Restraint is the floor.
2. **Editorial accents are earned, not sprayed.** Cormorant lives in three specific brand moments: the dashboard greeting, the login hero, and the wordmark. Everywhere else: Geist. The serif loses meaning if it's everywhere.
3. **Tool disappears into the task.** Chrome should never compete with content. Familiar affordances (Linear/Notion-class) over invented ones. Surfaces stay flat unless the content earns elevation.
4. **Theme coherence is non-negotiable.** Both light and dark must work as first-class; no mode is decorative. Every dark-mode behavior cascades through semantic tokens, not hand-coded `dark:` variants per usage.

## Accessibility & Inclusion

- WCAG 2.1 AA on all text and control contrast (met by the cream + strong-text token pairing in `apps/www/src/app/globals.css`).
- `prefers-reduced-motion` respected throughout; animations are gated in `globals.css` already.
- No specific known a11y user needs in scope. Standard developer-tool keyboard navigation expectations apply (focus-visible rings, tab order, escape-to-close, etc.).
