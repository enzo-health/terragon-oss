# Autoresearch: Optimistic Task Creation UI & Animation

## Objective

Improve the optimistic updates and UI feedback when users create new tasks. Focus on:

1. Enhanced visual feedback during optimistic task creation
2. Smoother animations for new tasks appearing in the thread list
3. Better loading/submitting states in the dashboard prompt box
4. Improved transitions from optimistic to real task state
5. Delightful micro-interactions that make task creation feel responsive and polished

## Current State

- `useCreateThreadMutation` in `queries/thread-mutations.ts` handles optimistic updates
- Optimistic threads are created with `optimistic-${timestamp}` IDs and inserted immediately
- `ThreadListItem` has basic `animate-in fade-in slide-in-from-top-1 duration-200` for new items
- `isOptimisticThread` flag disables interactions and shows "Creating..." text
- Dashboard uses `DashboardPromptBox` with `isSubmitting` state from `usePromptBox`

## Metrics

- **Primary**: Perceived responsiveness score (1-10 based on animation smoothness, visual feedback quality, transition polish)
- **Secondary**:
  - Animation frame rate (target: 60fps)
  - Time to first visual feedback (target: <50ms)
  - Visual consistency score

## How to Run

`./autoresearch.sh` — outputs `METRIC score=X` and `METRIC fps=Y` lines based on visual quality assessment.

## Files in Scope

- `apps/www/src/components/thread-list/item.tsx` — Thread list item rendering, optimistic state UI
- `apps/www/src/components/thread-list/main.tsx` — Thread list container, grouping logic
- `apps/www/src/queries/thread-mutations.ts` — Optimistic update logic, mutation hooks
- `apps/www/src/components/dashboard.tsx` — Dashboard with task creation
- `apps/www/src/components/promptbox/dashboard-promptbox.tsx` — Prompt box with submit handling
- `apps/www/src/components/promptbox/simple-promptbox.tsx` — Base prompt box UI
- `apps/www/src/components/chat/draft-task-dialog.tsx` — Draft task dialog

## Off Limits

- Server actions (new-thread.ts, draft-thread.ts)
- Database schema or queries
- Core mutation logic (don't break optimistic update functionality)
- Authentication or permission checks

## Constraints

- Must maintain accessibility (respect `prefers-reduced-motion`)
- Must not break existing optimistic update functionality
- Animations should be GPU-accelerated (transform/opacity only)
- Keep bundle size minimal - no heavy animation libraries unless justified
- All changes must work with existing TanStack Query cache logic

## What's Been Tried

### Session 1: Baseline Assessment

- Current animations: Basic `animate-in fade-in slide-in-from-top-1 duration-200` on list items
- Optimistic threads show "Creating..." with reduced opacity (0.8)
- Prompt box has `isSubmitting` state but limited visual feedback
- No transition animation when optimistic thread is reconciled to real thread

## Ideas Backlog

### High Priority

1. **Enhanced optimistic thread appearance** — Pulse animation, shimmer, or gradient border while creating
2. **Smooth reconciliation transition** — Animate the swap from optimistic to real thread ID
3. **Prompt box submitting state** — Better visual feedback during submission (button animation, input dimming)
4. **Staggered list entrance** — When multiple tasks created, stagger their appearance
5. **Success feedback** — Brief celebration when task created successfully

### Medium Priority

6. **Hover states on optimistic items** — Even though disabled, show they're interactive eventually
7. **Improved "Creating..." indicator** — Animated dots, progress hint, or agent avatar pulse
8. **Error state animation** — Smooth shake or error indication if creation fails

### Low Priority

9. **Sound design** — Optional subtle sound on task creation (respect system prefs)
10. **Haptic feedback** — On mobile, haptic feedback for task creation
