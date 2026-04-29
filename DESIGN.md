---
name: Terragon
description: AI-powered coding assistant platform — internal tool for parallel agent orchestration
colors:
  page-cream: "oklch(0.97 0.010 80)"
  card-cream: "oklch(0.94 0.010 80)"
  hover-cream: "oklch(0.905 0.010 80)"
  hairline: "oklch(0.885 0.010 80)"
  divider: "oklch(0.78 0.010 80)"
  mid-text: "oklch(0.50 0.010 80)"
  strong-text: "oklch(0.15 0.006 80)"
  code-floor: "oklch(0.18 0.005 80)"
  code-soft: "oklch(0.20 0.005 80)"
  code-elevated: "oklch(0.24 0.005 80)"
  on-dark: "oklch(0.97 0.010 80)"
  on-dark-soft: "oklch(0.66 0.010 80)"
  coral: "oklch(0.62 0.115 39)"
  coral-active: "oklch(0.51 0.10 40)"
  warning-terracotta: "oklch(0.62 0.095 54)"
  success-sage: "oklch(0.58 0.075 150)"
  error-clay: "oklch(0.55 0.16 22)"
  info-steel: "oklch(0.58 0.10 230)"
typography:
  display:
    fontFamily: "Cormorant Garamond, Tiempos Headline, EB Garamond, serif"
    fontSize: "1.75rem"
    fontWeight: 300
    lineHeight: "1.05"
    letterSpacing: "-0.025em"
  heading-1:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: "1.1"
    letterSpacing: "-0.02em"
  heading-2:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: "1.15"
    letterSpacing: "-0.015em"
  heading-3:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: "1.2"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.5"
    letterSpacing: "normal"
  lead:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.5"
  caption:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1.4"
  micro:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: "1.3"
    letterSpacing: "0.01em"
  mono:
    fontFamily: "Geist Mono, JetBrains Mono, SFMono-Regular, Menlo, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.5"
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  base: "1rem"
  lg: "1.5rem"
  xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.coral}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-primary-hover:
    backgroundColor: "{colors.coral-active}"
    textColor: "#ffffff"
  button-secondary:
    backgroundColor: "{colors.card-cream}"
    textColor: "{colors.strong-text}"
    rounded: "{rounded.full}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-outline:
    backgroundColor: "{colors.page-cream}"
    textColor: "{colors.strong-text}"
    rounded: "{rounded.full}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.strong-text}"
    rounded: "{rounded.full}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  button-disabled:
    backgroundColor: "{colors.divider}"
    textColor: "{colors.mid-text}"
    rounded: "{rounded.full}"
    padding: "0.5rem 1rem"
    height: "2.25rem"
  input:
    backgroundColor: "{colors.page-cream}"
    textColor: "{colors.strong-text}"
    rounded: "{rounded.xl}"
    padding: "0.75rem 1.25rem"
    height: "2.75rem"
  card:
    backgroundColor: "{colors.card-cream}"
    textColor: "{colors.strong-text}"
    rounded: "1.25rem"
    padding: "1.5rem"
  popover:
    backgroundColor: "{colors.card-cream}"
    textColor: "{colors.strong-text}"
    rounded: "{rounded.xl}"
    padding: "1rem"
  dialog:
    backgroundColor: "{colors.card-cream}"
    textColor: "{colors.strong-text}"
    rounded: "1rem"
    padding: "2rem"
  chip-info:
    backgroundColor: "{colors.info-steel}"
    textColor: "{colors.info-steel}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.625rem"
  chip-success:
    backgroundColor: "{colors.success-sage}"
    textColor: "{colors.success-sage}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.625rem"
  chip-error:
    backgroundColor: "{colors.error-clay}"
    textColor: "{colors.error-clay}"
    rounded: "{rounded.full}"
    padding: "0.125rem 0.625rem"
---

# Design System: Terragon

## 1. Overview

**Creative North Star: "The Working Studio"**

Terragon is an internal tool that inherits the warm-cream Anthropic visual family but conducts itself with Linear-flavored rigor. The interface is the workbench: dense, intentional, and quiet. Surfaces are warm enough to feel considered, restrained enough to disappear under the work. Editorial Cormorant moments are _cited inheritance_ (the dashboard greeting, the login hero, the wordmark) — not the brand voice. Every other surface is Geist, hairlines, density.

The system is built on a single mathematical color rule: `oklch(L 0.010 80)`. Every neutral on the cream ladder shares the same hue (warm yellow-beige, the Anthropic editorial band) and the same low chroma (0.010 — visible on careful inspection, neutral in normal use). Only lightness varies. The result is a tonal ladder that reads as one continuous cream surface rather than a stack of unrelated grays. Coral is the single accent; sage / clay / terracotta / steel-blue carry semantics.

This system explicitly rejects the SaaS dashboard cliché (gradient hero metrics, big-number cards, indigo defaults, identical card grids), the AI cyberpunk aesthetic (neon-on-black, glassmorphism, generative-orb chrome), and marketing-fluid typography in dense UI (`clamp()` headings, scroll-driven type, fluid spacing in app surfaces).

**Key Characteristics:**

- Warm cream as the canvas, not white. Pure white is forbidden.
- One mathematical ladder (`oklch(L 0.010 80)`) — varying only lightness.
- Coral as the _only_ brand accent; everything else is tonal.
- Geist owns the working voice. Cormorant owns three brand moments and nothing else.
- Flat-by-default surfaces; hairlines do the dividing work.
- Both light and dark themes carry equal weight; dark is not optional.

## 2. Colors: The Working Cream Palette

A single warm-cream tonal ladder built on the hue-80 / chroma-0.010 rule, with one coral accent and four semantic anchors at L=0.55–0.62. Diff red/green is its own domain — the only place where pure Tailwind palette values are sanctioned.

### Primary

- **Coral** (oklch(0.62 0.115 39)): the single brand accent. Primary buttons, the wordmark, focus rings, status pills (when status _is_ the brand), the dashboard's signature moments. Used on ≤10% of any given screen.
- **Coral Active** (oklch(0.51 0.10 40)): the WCAG-AA-passing darker variant for foreground use on cream surfaces. Active states, sidebar accent, pressed buttons.

### Neutral

- **Page Cream** (oklch(0.97 0.010 80)): the page floor. Body background, sidebar, the canvas everything else sits on. Pure white is forbidden — this is the lightest the system goes.
- **Card Cream** (oklch(0.94 0.010 80)): cards, popovers, dialogs, prompt boxes. A 3-point lift from page-cream — gentle elevation without theatricality.
- **Hover Cream** (oklch(0.905 0.010 80)): hover surfaces, muted regions, recessed backgrounds. The "press" state for interactive cells.
- **Hairline** (oklch(0.885 0.010 80)): dedicated border stop. Sits between card-cream and hover-cream so borders hold definition no matter which surface they sit on. Divider, input border, hairline separator across panels.
- **Divider** (oklch(0.78 0.010 80)): heavier dividers, disabled fills, deliberately-not-quite-text gray.
- **Mid Text** (oklch(0.50 0.010 80)): secondary text, captions, muted labels.
- **Strong Text** (oklch(0.15 0.006 80)): body text, headings, primary content. ~17:1 contrast against page-cream.

### Code & Terminal Anchored Dark

The code/terminal surfaces don't theme-flip. They stay at the Anthropic brand floor (`#181715`-equivalent) regardless of light/dark mode. The dark surface IS the brand value.

- **Code Floor** (oklch(0.18 0.005 80)): terminal backgrounds, code blocks, the dashboard's anchored-dark moments.
- **Code Soft** (oklch(0.20 0.005 80)): code surface variants.
- **Code Elevated** (oklch(0.24 0.005 80)): elevated panels on the dark surface.
- **On Dark** (oklch(0.97 0.010 80)): primary text on the dark surface.
- **On Dark Soft** (oklch(0.66 0.010 80)): secondary text on the dark surface.

### Semantic

All semantics chosen to feel editorial-warm rather than SaaS-default. No emerald (sage instead). No amber (terracotta instead). No royal blue (steel instead).

- **Success Sage** (oklch(0.58 0.075 150)): completion states, healthy connection pills, "merged PR" indicators.
- **Warning Terracotta** (oklch(0.62 0.095 54)): warnings, deprecation, near-limit states.
- **Error Clay** (oklch(0.55 0.16 22)): errors, destructive actions, failure indicators. Distinct hue (22) from coral primary (39) — they will not visually collide.
- **Info Steel** (oklch(0.58 0.10 230)): delegation chips, info pills, neutral status. Moderate chroma so it doesn't feel cold against the warm-cream surface.

### Named Rules

**The One Voice Rule.** Coral is the only accent. It carries primary action, focus, and brand presence. It is used on ≤10% of any given screen — its rarity is the point. If a surface needs more color, it does not need more coral.

**The Cream Ladder Rule.** Every neutral lives on the `oklch(L 0.010 80)` ladder. No ad-hoc grays. No Tailwind palette values for chrome. If a designer wants a neutral that isn't on the ladder, they extend the ladder; they do not bypass it.

**The Anchored Dark Rule.** Code and terminal surfaces are warm-dark (oklch ~0.18, hue 80). They do not theme-flip. The dark surface IS the Anthropic brand floor; light mode passes through it unchanged.

**The No-Diff-Brand-Color Rule.** Diff add/remove uses pure emerald/red (Tailwind palette) — not sage/clay. Diff convention universally expects red-removed / green-added; brand semantic colors would feel wrong in this domain.

## 3. Typography

**Display Font:** Cormorant Garamond (with Tiempos Headline, EB Garamond fallbacks)
**Body Font:** Geist (with Inter, ui-sans-serif fallbacks)
**Mono Font:** Geist Mono (with JetBrains Mono, SFMono-Regular fallbacks)

**Character:** Geist is the working voice — clean geometric sans, weight 400 for body, 500–600 for hierarchy. Cormorant is the editorial accent — serif, weight 300, used in three deliberate brand moments. The pairing communicates "considered tool with a citable lineage", not "marketing-driven SaaS."

### Hierarchy

- **Display** (Cormorant, 300, 28px, lh 1.05, tracking -0.025em): brand moments only — the dashboard greeting, the login hero, the wordmark. Three locations, full stop.
- **Heading 1** (Geist, 600, 20px, lh 1.1, tracking -0.02em): page titles. Light tracking for tight headlines; Geist's optical metrics carry the rest.
- **Heading 2** (Geist, 600, 18px, lh 1.15, tracking -0.015em): section heads.
- **Heading 3** (Geist, 600, 16px, lh 1.2, tracking -0.01em): subsection heads, dialog titles.
- **Heading 4–6** (Geist, 500, 14–16px, lh 1.25, tracking -0.005em): minor headings, settings labels.
- **Body** (Geist, 400, 14px, lh 1.5): the workhorse — used in 303 sites. Reads at 65–75ch on prose, denser on data tables. The de-facto body size of the entire interface.
- **Lead** (Geist, 400, 15px, lh 1.5): emphasized body, intro paragraphs.
- **Caption** (Geist, 400, 12px, lh 1.4): secondary metadata, table cells, muted helper text. Aligned with Tailwind `text-xs` for token consistency.
- **Micro** (Geist, 500, 11px, lh 1.3, tracking 0.01em): labels, badges, tight chrome. Sidebar section labels often use this in `uppercase` with `tracking-[0.06em]`.
- **Mono** (Geist Mono, 400, 13px, lh 1.5): code, branch names, repo paths, terminal output, technical chrome. Used in ~92 sites — the system is mono-heavy by design.

### Named Rules

**The Three-Moment Cormorant Rule.** Cormorant Garamond appears in exactly three places: the dashboard greeting, the login hero, the wordmark. Anywhere else is wrong. The serif loses meaning if it's everywhere; restraint amplifies signal.

**The Geist-By-Default Rule.** Default `h1`–`h6` render in Geist with weight 500–600. The `font-display` utility is opt-in for the three brand moments — never the default. Applying serif to a generic Card, Dialog, or section heading is forbidden.

**The Tabular-Nums Rule.** Any number that updates at runtime (token counts, timers, rate-limit gauges) opts into `tabular-nums` via `[data-stream-counter]` or the `.tabular-nums` class. Layout-shift on changing digits is a defect.

## 4. Elevation

The system is **flat-by-default**. Surfaces stay flat at rest; depth comes from the cream tonal ladder (a 3-point oklch lift between page-cream and card-cream is the ambient elevation cue) and from hairline borders. Shadows appear only on **floating surfaces** — popovers, dialogs, dropdowns, tooltips, the prompt box — and on focused/hovered interactive cards.

Shadows are calibrated for cream specifically: warm-cream amplifies dark drop-shadows compared to neutral gray, so alpha values that look subtle on a Stripe-style gray system read as bold here. The system pulls all shadow alphas down by ~30–40% from typical defaults.

### Shadow Vocabulary

- **Inset Edge** (`box-shadow: inset 0 0 0 0.5px rgba(0, 0, 0, 0.075)`): the 0.5px hairline edge that defines a card's outline against its surface. Used in conjunction with cream-tonal lift for ambient elevation.
- **Outline Ring** (`box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.05)`): single-layer 1px outline for icons-on-cream, image edges, the dashboard hero buttons.
- **Card** (`0 1px 2px rgba(0,0,0,0.025), 0 2px 6px rgba(0,0,0,0.03), inset 0 0 0 0.5px rgba(0,0,0,0.05)`): the standard card lift. Shadows are deliberately understated.
- **Warm Lift** (`0 4px 12px rgba(78, 50, 23, 0.03), inset 0 0 0 0.5px rgba(0,0,0,0.05)`): the prompt-box at-rest shadow. Warm-tinted (low brown-saturation) for editorial cohesion with the cream surface.
- **Tailwind Scale** (`shadow-xs` through `shadow-2xl`): cascading neutral shadow sizes for floating surfaces. All alphas ≤0.12.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. Shadows appear only as a response to state (hover, elevation, focus) or for surfaces that genuinely float (popover, dialog, dropdown, tooltip).

**The Cream-Calibrated Shadows Rule.** Shadow alphas in this system run ~30–40% lower than typical Stripe/Linear/gray-system defaults. Cream amplifies darkness. If a shadow looks "right" against a gray reference, it's too heavy on cream. Halve the alpha, double the blur.

**The Hairline-Beats-Shadow Rule.** When a surface needs to be distinguished from its container, prefer a hairline border (oklch(0.885 0.010 80)) over a shadow. Shadows are reserved for surfaces that genuinely lift off the page.

## 5. Components

Component voice: **refined and restrained**. Soft press feedback (2% scale), thin focus rings (2px), warm-cream backgrounds with hairline definition. Linear-tier ergonomics — every interaction state covered, none of them shouting.

### Buttons

- **Shape:** Pill-form by default — `rounded-full` (9999px). The radius is constant; size variants change height and padding only.
- **Primary:** Coral background (`oklch(0.62 0.115 39)`) with white text. Hover lifts to coral-active. Used for the dispatch action ("Save Changes", "Run Task", "Send"). One per screen.
- **Secondary:** Card-cream background with strong-text. Soft outline-ring shadow. Used for non-primary affirmative actions.
- **Outline:** Page-cream background with hairline border. Used for "cancel", "back", and tertiary affirmatives.
- **Ghost:** Transparent at rest; hovers to hover-cream. Used for icon buttons, sidebar items, dense chrome.
- **Warm:** Bespoke variant using `--warm-stone` (raised + 30% transparency) and warm-lift shadow. Used for the wordmark badge and a few editorial moments.
- **Disabled:** Divider (oklch(0.78)) background with mid-text. Pointer events disabled, scale animation disabled.
- **Hover / Focus:** Background color shift only — no scale-on-hover. Active state presses 2% (`scale-[0.98]`). Focus uses 2px coral ring at 50% opacity (`focus-visible:ring-2 ring-ring/50`). Transitions on `[color, background-color, border-color, opacity, box-shadow, transform]` over 150ms `cubic-bezier(0.2, 0, 0, 1)`.

### Inputs / Fields

- **Style:** Page-cream background (lifts above the surrounding card-cream), rounded-xl (16px), 1px hairline border. Input is warmer than its container — it reads as "raised paper" cut into the card.
- **Focus:** Border shifts to coral at 60% opacity; 2px coral focus ring at 20% opacity. No glow, no border-width change.
- **Disabled:** 50% opacity, pointer events disabled.
- **Error:** Border + ring shift to clay-error. 20% ring opacity in light mode, 40% in dark.

### Cards / Containers

- **Corner Style:** 1.25rem (20px) — slightly more generous than smaller-radius components, signaling "container" not "control".
- **Background:** Card-cream (the standard card surface).
- **Shadow Strategy:** Inset Edge or Outline Ring at rest (no drop shadow). Drop shadow only when the card represents a floating surface (hover-elevated, "draggable" state).
- **Border:** None at rest — the inset shadow does the edge work. Hairline border (1px, oklch(0.885)) when extra definition is needed against varied backgrounds.
- **Internal Padding:** 1.5rem (24px) standard. Cards with no header use 2rem.

### Popovers / Dropdowns / Tooltips / Selects

- **Shape:** rounded-xl (16px). All popover-class surfaces share the same rounding.
- **Background:** Card-cream. Theme-flipped via the `--popover` token; never `bg-white`.
- **Shadow:** `shadow-card` (the calibrated three-layer card lift).
- **Border:** 1px hairline, optional.
- **Animation:** `animate-in fade-in zoom-in-95 slide-in-from-{side}-2`. ~150ms entrances; `animate-out` on close. Respects `prefers-reduced-motion`.

### Dialog / Sheet

- **Shape:** Dialog uses 1rem corner radius; Sheet uses border-only definition (no corner radius — slides in from edge).
- **Backdrop:** White at 40% with 2px backdrop-blur. The wash dims the page without going to a pure-black overlay (which would read corporate against cream).
- **Content:** Card-cream surface, 2rem padding, `shadow-card`.

### Sidebar (Signature)

- **Style:** Surface flat against canvas — `bg-canvas` (page-cream). Right-edge hairline (oklch(0.885)) is the only separator. No shadow, no surface lift.
- **Items:** Ghost-button treatment — transparent at rest, hover-cream on hover, sunken with coral-active text-color when active.
- **Active indicator:** A 2px coral leading bar on the active item's left edge — the _only_ place a vertical accent stripe appears in the system, and it is a 2px indicator, not a side-stripe border.

### Prompt Box (Signature)

- **Style:** Card-cream surface with `shadow-warm-lift` and `rounded-[calc(var(--radius)+0.2rem)]` (~17px) — the only place a custom radius is used, marking the prompt box as the signature input.
- **Focus:** Border shifts to coral at 60%; coral ring at 20%.
- **Submitting:** Animates a 0.5px progress bar at the top edge, fades to opacity-80, applies `pulse-subtle` animation. Visible state-conveyance — never just a spinner.

### Status Pills

- **Style:** `bg-{semantic}/10` with `text-{semantic}`. Rounded-full. Padding 0.625rem horizontal, 0.125rem vertical.
- **Variants:** info-steel, success-sage, warning-terracotta, error-clay.
- **Strict rule:** Status pills never use raw Tailwind palette colors. Migrating from `bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400` to `bg-info/10 text-info` is the canonical pattern.

## 6. Do's and Don'ts

### Do:

- **Do** anchor every neutral on the `oklch(L 0.010 80)` ladder. No ad-hoc grays.
- **Do** use Geist for default headings (weights 500–600) and reserve Cormorant for the three brand moments.
- **Do** use 2% press scale (`active:scale-[0.98]`) and 2px focus rings — `ring-2 ring-ring/50`.
- **Do** keep shadows soft. Cream amplifies darkness; halve the alpha you'd use on a gray system.
- **Do** prefer hairline borders (oklch(0.885)) over shadows when distinguishing a surface from its container.
- **Do** use `bg-{semantic}/10 text-{semantic}` for status pills. Status colors theme-flip through tokens.
- **Do** keep coral on ≤10% of any given screen. Its rarity is its meaning.
- **Do** test every interactive component against all eight states: default, hover, focus, active, disabled, loading, error, success.
- **Do** respect `prefers-reduced-motion`. All custom animations must have a `@media (prefers-reduced-motion: reduce)` opt-out.

### Don't:

- **Don't** use pure white (`#fff`) or pure black (`#000`). Page-cream and strong-text are the lightest and darkest the system goes. `bg-white` is the most common drift; if you see it in a primitive, it's wrong.
- **Don't** spray Cormorant on generic chrome (Card titles, Dialog titles, Sheet titles, Settings rows, list section labels). These are all wrong.
- **Don't** use `clamp()` heading sizes or fluid typography in app surfaces. This is a marketing-page idiom; internal-tool dense UI uses a fixed `rem` scale.
- **Don't** reach for the Tailwind palette (`text-blue-600`, `bg-red-50`, `border-gray-200`) when a semantic token exists. The `--success`, `--error`, `--warning`, `--info`, `--coral`, `--hairline-strong` tokens cover ~95% of color needs.
- **Don't** ship a SaaS dashboard cliché — gradient hero metrics, big-number/small-label cards, identical card grids, indigo defaults. This is the default-competitor look the brand explicitly rejects.
- **Don't** ship the AI cyberpunk aesthetic — neon-on-black, glowing orbs, glassmorphism, generative-orb chrome, "futuristic" gradients. The lazy "AI tool" stereotype.
- **Don't** use `border-left` greater than 1px as a colored accent stripe on cards, list items, or callouts. Side-stripe borders are forbidden. (The 2px coral leading bar on active sidebar items is a _2px indicator_, not a side-stripe border, and is the system's single sanctioned exception.)
- **Don't** use gradient text (`background-clip: text` on a gradient) anywhere. Single solid color, weight or size for emphasis.
- **Don't** use glassmorphism (heavy backdrop-blur on translucent surfaces) decoratively. The Dialog backdrop blur is functional (dims the page); decorative glass cards are forbidden.
- **Don't** use modal as the first thought for any flow. Exhaust inline / progressive alternatives.
- **Don't** hand-code `dark:` variants for surface colors (`dark:bg-gray-800`, `dark:text-red-400`). Theme behavior cascades through semantic tokens, not per-usage hand-coding. If you find yourself writing a `dark:` variant for a surface or status color, the right fix is upstream in the token.
- **Don't** use em dashes in copy. Use commas, colons, semicolons, periods, or parentheses instead. Also not `--`.
