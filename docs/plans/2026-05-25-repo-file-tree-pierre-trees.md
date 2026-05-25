# Repo file tree in the artifacts panel (`@pierre/trees`)

## Goal

Give users a browsable file tree of the repo in the chat's artifacts panel. Clicking a node opens that file in the existing in-repo preview, and the tree highlights whichever file the preview currently shows — so users can "see where they are."

## Decision: placement

A `repo-tree` **artifact tab** in the existing secondary panel. The panel already renders one tab per `ArtifactDescriptor` and switches on `descriptor.kind` in `ActiveArtifactRenderer` (`secondary-panel-shell.tsx:334`). The tree becomes one more synthetic artifact kind, reusing the same tab chrome, resize, maximize, and mobile-drawer plumbing. No new layout.

This rides on the same machinery as PR #196's repo-file preview, which is the click target for tree rows.

## Why `@pierre/trees`

Same vendor as `@pierre/diffs@^1.0.11`, already a dependency and already powering the preview's source view. The React entry (`@pierre/trees/react`) exposes `useFileTree({ preparedInput })` + `<FileTree model={model} />`, with path-string identity, `model.setFocus(path)`, `model.setGitStatus(...)`, and row decorations.

## Architecture (mirrors the repo-file artifact, end to end)

| Layer         | repo-file (exists)                                                 | repo-tree (new)                                                            |
| ------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Open event    | `createRepoFileOpenedEvent` (`optimistic-events.ts:39`)            | `createRepoTreeOpenedEvent`                                                |
| Reducer case  | `"repo-file.opened"` (`reducer.ts:98`)                             | `"repo-tree.opened"`                                                       |
| Descriptor    | `createRepoFileArtifactDescriptor` (`artifact-descriptors.ts:588`) | `createRepoTreeArtifactDescriptor`                                         |
| Artifact id   | `buildRepoFileArtifactId` → `artifact:repo-file:<ref>:<path>`      | `buildRepoTreeArtifactId` → `artifact:repo-tree:<ref>` (singleton per ref) |
| `kind` union  | `"repo-file"` (`artifact-descriptors.ts:93`)                       | add `"repo-tree"`                                                          |
| Renderer case | `RepoFileArtifactRenderer` (`secondary-panel-shell.tsx:347`)       | `RepoTreeArtifactRenderer`                                                 |
| Server data   | `getRepoFileContentAction` (`get-repo-file-content.ts`)            | `getRepoTreeAction` (new)                                                  |

### 1. Dependency

`pnpm --filter @terragon/www add @pierre/trees`. Pin to an exact version (the diffs package churns; treat trees the same). Confirm it ships ESM types for the `/react` subpath.

### 2. Server action — `apps/www/src/server-actions/get-repo-tree.ts`

Clone `get-repo-file-content.ts` structure exactly (it is the security template):

- Same authz: `getThreadPageShellWithPermissions({ allowAdmin: false })`, then re-check the `repoFilePreview` flag server-side.
- **Ref cascade**: reuse the working-branch→base fallback shipped in PR #196. Read-only/exploration threads have an unpushed `branchName`, so the tree must resolve against base.
- Fetch with `octokit.rest.git.getTree({ owner, repo, tree_sha: ref, recursive: "1" })`. Returns `{ tree: [{ path, type: "blob"|"tree", ... }], truncated: boolean }`.
- Keep only `type === "blob"` paths (the tree library builds folders from the path segments). Drop submodules (`commit`) and we don't need explicit `tree` entries.
- **Truncation**: GitHub truncates at ~100k entries / 7MB and sets `truncated: true`. Return that flag so the UI can show a "tree is partial" notice rather than silently lying.
- PHI-safe opaque error categories, same as the file action: `unauthorized | feature-disabled | not-found | github-error | too-large` (+ `truncated` as a non-error field on the success result).
- Result shape: `{ status: "ready"; ref: string; paths: string[]; truncated: boolean } | { status: "error"; category }`.

### 3. Synthetic artifact wiring

- `packages/shared/src/db/artifact-descriptors.ts`: add `"repo-tree"` to the kind union, a `RepoTreeArtifactDescriptor` (carries `ref`), `buildRepoTreeArtifactId({ ref })`, `createRepoTreeArtifactDescriptor({ ref })`. Title `"Files"`, summary the repo name.
- `optimistic-events.ts` + `types.ts`: `createRepoTreeOpenedEvent({ ref })` → `{ type: "repo-tree.opened", ref }`.
- `reducer.ts`: `case "repo-tree.opened"` → upsert the singleton descriptor into `state.artifacts` (dedup by id so re-opening focuses the existing tab).
- `secondary-panel-shell.tsx`: `case "repo-tree": return <RepoTreeArtifactRenderer ... />`.

### 4. Renderer — `secondary-panel-repo-tree.tsx`

- On mount, call `getRepoTreeAction({ threadId })`; loading / error / ready states mirror `RepoFileArtifactRenderer`.
- `const model = useFileTree({ preparedInput: prepareFileTreeInput(paths) })`; render `<FileTree model={model} />`.
- **Row click → open file**: wire the tree's selection/activation to `onOpenRepoFile(path)` — the same callback markdown links and Read/Write/Edit affordances already use. Opens a `repo-file` artifact tab.
- **"Where am I"**: subscribe to the active `repo-file` artifact's path; call `model.setFocus(path)` so the tree scrolls to and highlights the open file. (The active artifact id is already known to `chat-ui.tsx`; pass the active repo-file path down.)
- Show the `truncated` notice inline when set.
- Optional later: `model.setGitStatus(...)` from `thread.gitDiffStats`/diff to color changed files. Out of scope for v1.

### 5. Entry point — how the "Files" tab appears

Add a small "Browse files" affordance (folder icon) in the panel header or chat header that dispatches `createRepoTreeOpenedEvent({ ref })`. Reuse the same ref resolution `chat-ui.tsx:342` already computes (`thread.branchName ?? thread.repoBaseBranchName`). Gate the affordance on `repoFilePreviewEnabled` so the whole feature stays behind one flag.

### 6. Gating

Reuse `repoFilePreview`. No new flag. The server action re-checks it; the entry affordance is hidden when off.

## Edge cases

- **Unpushed working branch** → base fallback (PR #196 cascade). Without it, exploration threads get an empty/404 tree.
- **Huge monorepo** → `truncated: true`; show partial-tree notice. (Bonaparte is the target repo — verify it fits under 100k blobs; if not, v2 needs lazy per-folder loading via `getContent` per directory.)
- **Empty repo / bad ref** → `not-found`, clean empty state.
- **Chat switch** → reducer re-seeds artifacts from snapshot; the singleton id keyed by `ref` prevents cross-thread leakage (same guarantee as repo-file).

## Tests

- `get-repo-tree.test.ts`: authz denial, flag-off, ref cascade (working 404 → base), truncation flag passthrough, blob/non-blob filtering, PHI-safe categories. Mirror `get-repo-file-content.test.ts`.
- Reducer test: `repo-tree.opened` upserts a singleton, re-open focuses not duplicates.
- Renderer wiring test: row click calls `onOpenRepoFile`; active-path drives `setFocus`.

## Open questions

1. **Entry point location** — panel header folder icon, chat header, or auto-open the Files tab the first time the panel opens? (Leaning: panel header icon, manual.)

2. **Truncation strategy for Bonaparte** — is the repo under GitHub's recursive-tree limit? If not, do we need lazy per-folder loading in v1, or is a partial tree acceptable to start?

3. **Git status coloring** — show changed-file decorations from the thread diff in v1, or defer?

4. `@pierre/trees` **SSR** — render client-only (the panel is already client), so skip the SSR `preloadedData` path?

## Out of scope (v1)

- Lazy/virtualized per-directory loading, git-status decorations, file search within the tree, drag/rename/move, multi-ref trees. The path-string model leaves all of these open for later without a rewrite.
