# Notes-Editor Gap List Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three notes-editor gaps — FR-11 rename (move + rewrite inbound `[[links]]`), FR-12 backref preview before delete, and FR-16 frontmatter reveal (which also builds the missing FR-2 frontmatter hide) — as a single editor/link cluster.

**Architecture:** Rename and backref-preview share one main-side scan helper (`scanBackrefs`) and two new router procedures (`notes.rename`, `notes.backrefs`); the renderer gets a `renameNoteAtom` and a delete-preview dialog. Frontmatter becomes a single in-editor atomic widget over the leading `---…---` region (the `markdownTables()` pattern) — one file, one document, one `EditorView`, so the `base`/`mine`/`disk` merge machinery is untouched. A debounced YAML check drives a status dot and a save gate.

**Tech stack:** TypeScript, tRPC (main ↔ renderer), CodeMirror 6, Jotai, Vitest 4, the `yaml` package (already a `@holi/shared` dep).

**House style:** This plan is deliberately lean — contracts, signatures, assertion lists, and gotchas, **not** full inline implementations. The executing engineer writes the code from the contract. Test steps give assertion bullets + exact commands, not full test bodies.

---

## Conventions & gotchas (read once, applies throughout)

- **Bare `node`/`npx` is broken — use `pnpm exec`.** The shell cwd resets between commands; `cd` explicitly every time or use absolute paths.
- **Test commands.** Desktop suite: `cd apps/desktop && pnpm exec vitest run <file>`. Shared suite: `cd packages/shared && pnpm exec vitest run <file>`. `fileParallelism: false` and `testTimeout: 20_000` are already set in `vitest.config.ts` — do not touch.
- **Renderer state tests are node-env `.ts` only**, driven by `test/helpers/fake-holi.ts` — `installFakeHoli(handle)` installs a real `window.holi.trpc(op)` serviced by your `handle(op)` function (it is **not** a tRPC mock; the real `lib/trpc.ts` client + `ipc-link` run). Assert behaviour by driving the real atoms and inspecting the ops your `handle` received. Copy the pattern from `test/vaults-state.test.ts` / `test/session-state.test.ts`. **Test files are flat in `apps/desktop/test/`** (e.g. `vaults-state.test.ts`, `panes.test.ts`) — there is no `test/state/` or `test/editor/` subdir; do not create one. Components (`.tsx`) stay thin and are verified with `apps/desktop/cdp.mjs` against the running app, not unit-tested.
- **The board renders one live `EditorPane` at a time** (`Shell.tsx:178`) — the active tab. Switching tabs unmounts the pane and flushes its buffer (`EditorPane.tsx:133-148`). So "coordinate with open buffers" reduces to "the one active buffer," but always call `flushAllBuffers()` (`lib/buffer-registry.ts:32`) rather than reaching for the active one — the registry is the contract.
- **Wiki-link grammar is fixed and exact-match.** `rewriteWikiLinks(text, from, to)` (`packages/shared/src/wiki-links.ts:89`) matches `kind === 'note' && target === fromPath` on the vault-relative path verbatim, preserves `|Label`, and leaves `[[task:<id>]]` chips untouched. Do not reimplement matching — reuse this and `parseWikiLinks`.
- **GFM Lezer does not parse YAML frontmatter into a node.** The frontmatter widget's region must be detected from the **text** (reuse the fence logic in `splitFrontmatter`), not queried from the syntax tree. Do not add a frontmatter Lezer parser.
- **`electron-vite` resolves imports without typechecking** — wiring a quarantined/erroring file onto the boot path fails silently at window-open, not at build. Keep new modules clean.
- **Backticks in a `git commit -m` heredoc get shell-substituted.** Write multi-line messages to a file and use `git commit -F`.
- **Commit message trailer:** end each commit body with `Claude goes brr.. via Dash`.

---

## File structure

**Shared (`packages/shared/src/`)**
- Modify `task-file.ts` — export the existing private `splitFrontmatter` (currently local at ~line 274).
- Modify `index.ts` — re-export `splitFrontmatter`.
- Reused as-is: `wiki-links.ts` (`parseWikiLinks`, `rewriteWikiLinks`, `formatWikiLink`).

**Main (`apps/desktop/src/main/`)**
- Create `vault/backrefs.ts` — `scanBackrefs(root, path)`, the one scan both rename and delete-preview consume.
- Modify `router.ts` — add `notes.backrefs` (query) and `notes.rename` (mutation) to the existing `notes` router (~line 510).
- Reused as-is: `vault/vault-files.ts` (`moveDocFile`, `writeAtomic`, `absPathFor`, `listFiles`, `toVaultRel`).

**Renderer (`apps/desktop/src/renderer/src/`)**
- Modify `state/vaults.ts` — add `renameNoteAtom` and `backrefsFor` (replace the "deliberately absent" comment block ~line 160).
- Modify `components/FileTree.tsx` — rename affordance; replace the bare `window.confirm` delete with a backref-preview dialog.
- Create `editor/frontmatter-region.ts` — pure `frontmatterRegion(doc)` and `frontmatterYamlValid(doc)`.
- Create `editor/frontmatter.ts` — the block widget + decoration + validity `StateField`.
- Modify `editor/extensions.ts` — add the frontmatter extension to `baseEditorExtensions`.
- Modify `components/EditorPane.tsx` — gate `save()` on frontmatter validity (autosave + ⌘S hold off; the unmount flush writes anyway).
- Reused as-is: `lib/buffer-registry.ts`, `state/panes.ts` (`workspaceAtom`, `Tab`).

**Global (`apps/desktop/src/renderer/src/global.d.ts`, `preload`)**: none — new procedures ride the existing tRPC router surface, no new `window.holi` channel.

---

## Task 1: Export `splitFrontmatter` from shared

The YAML integrity check (Task 9) must split frontmatter the *exact* way the downstream task/daily parsers do, or the status dot lies. `splitFrontmatter` already exists as a private helper in `task-file.ts`; expose it.

**Files:**
- Modify: `packages/shared/src/task-file.ts` (~line 274, the `function splitFrontmatter`)
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/frontmatter-split.test.ts` (create)

**Contract:** `export function splitFrontmatter(text: string): { yaml: string | null; body: string }`. `yaml === null` means no `---\n…\n---` fence (the whole file is body). An unterminated fence throws (existing behaviour — keep it).

- [ ] **Step 1: Write the failing test.** Cases: (a) no fence → `{ yaml: null, body: <trimmed text> }`; (b) valid fence → `yaml` is the inner text, `body` is what follows; (c) fence with empty body → `body === ''`; (d) unterminated `---` with no close → throws. Import `splitFrontmatter` from `@holi/shared`.
- [ ] **Step 2: Run test, verify it fails** — `cd packages/shared && pnpm exec vitest run test/frontmatter-split.test.ts`. Expected: FAIL — `splitFrontmatter` is not exported.
- [ ] **Step 3: Implement.** Change `function splitFrontmatter` → `export function splitFrontmatter` in `task-file.ts`; add `export { splitFrontmatter } from './task-file'` (or fold into the existing re-export) in `index.ts`. No logic change.
- [ ] **Step 4: Run test, verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit** — `git add packages/shared && git commit -F <msgfile>` with subject `feat(shared): export splitFrontmatter for the frontmatter widget`.

---

## Task 2: `scanBackrefs` main helper

The single inbound-link scan. Both `notes.backrefs` (delete preview) and `notes.rename` (find files to rewrite) call it. Walks the vault, reads each markdown file, and counts note-links pointing at the target path.

**Files:**
- Create: `apps/desktop/src/main/vault/backrefs.ts`
- Test: `apps/desktop/test/backrefs.test.ts` (create)

**Contract:** `export async function scanBackrefs(root: string, target: string): Promise<{ path: string; count: number }[]>`.
- Uses `listFiles(root)` (already prunes `.git`/ignored dirs), filters to `.md`, reads each, runs `parseWikiLinks`, counts matches where `kind === 'note' && target === <target>`.
- Excludes the target file itself (a note linking to itself is not a *backref* to preview/rewrite).
- Files with zero matches are omitted. Result order: by `path`, ascending (stable, testable).
- A file that fails to read is skipped, not fatal (mirrors `scanVault`'s `.catch(() => null)`).

- [ ] **Step 1: Write the failing test.** Build a temp vault dir with: `a.md` containing two `[[notes/target.md]]` (one plain, one `|Label`), `b.md` containing one `[[notes/target.md]]` plus a `[[task:xyz]]` (must NOT count), `c.md` containing no links, and `notes/target.md` linking to itself (must NOT count). Assert result `=== [{ path: 'a.md', count: 2 }, { path: 'b.md', count: 1 }]`.
- [ ] **Step 2: Run test, verify it fails** — `cd apps/desktop && pnpm exec vitest run test/backrefs.test.ts`. Expected: FAIL — module not found.
- [ ] **Step 3: Implement `scanBackrefs`** per the contract, reusing `listFiles` and `parseWikiLinks`.
- [ ] **Step 4: Run test, verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit** — subject `feat(main): scanBackrefs, the shared inbound-link scan`.

---

## Task 3: `notes.backrefs` router query

Expose `scanBackrefs` to the renderer for the delete-preview dialog.

**Files:**
- Modify: `apps/desktop/src/main/router.ts` (the `notes` router, ~line 510)
- Test: `apps/desktop/test/router.test.ts` (extend)

**Contract:** `notes.backrefs`: query, input `{ remote: string, path: string }` (validate via existing `fields({ remote: 'string', path: 'string' })` + `safe(path)` + `rootFor(remote)`), returns `{ path: string; count: number }[]` from `scanBackrefs`.

- [ ] **Step 1: Write the failing test** in `router.test.ts` using the existing `rig({ ... })` harness. Seed files where `a.md` links `[[b.md]]` twice; call `router.notes.backrefs({ remote, path: 'b.md' })`; assert `[{ path: 'a.md', count: 2 }]`.
- [ ] **Step 2: Run test, verify it fails** — `cd apps/desktop && pnpm exec vitest run test/router.test.ts`. Expected: FAIL — `notes.backrefs` is not a function.
- [ ] **Step 3: Implement** the `backrefs` procedure in the `notes` router; import `scanBackrefs`.
- [ ] **Step 4: Run test, verify it passes.** Expected: PASS.
- [ ] **Step 5: Commit** — subject `feat(main): notes.backrefs query`.

---

## Task 4: `notes.rename` router mutation

Move the file **and** rewrite every inbound `[[link]]` in one pass. This is the move-plus-rewrite the FileTree comment (`FileTree.tsx:9`) says must never ship half-done.

**Files:**
- Modify: `apps/desktop/src/main/router.ts` (the `notes` router)
- Test: `apps/desktop/test/router.test.ts` (extend)

**Contract:** `notes.rename`: mutation, input `{ remote: string, from: string, to: string }`, returns `{ rewritten: { path: string; count: number }[] }`.
- Validate both paths via `safe()`. Resolve `root` via `rootFor(remote)`.
- **Refuse if `to` already exists** (reuse the `exists(root, rel)` helper) → `TRPCError` `CONFLICT` — same "create must not clobber" rule as `notes.create` (`router.ts:536`).
- Order: (1) `scanBackrefs(root, from)` to get the referrer list; (2) for each referrer, read → `rewriteWikiLinks(text, from, to)` → `writeAtomic` (skip if `count === 0`, which shouldn't happen but is cheap insurance); (3) `moveDocFile(root, from, to)` last, so a mid-run failure leaves the source file present and inspectable in `git status` (PRD §173 — no transaction, but every step is a restorable file write).
- `from`/`to` are full vault-relative paths, so "rename is also move": a different folder prefix relocates the note; `moveDocFile`/`writeAtomic` already `mkdir -p` the destination.
- Does **not** commit — the renderer flushes and commits around the call (Task 5). The router stays git-agnostic (`router.ts` header).

- [ ] **Step 1: Write the failing test** in `router.test.ts`. Seed: `old.md` (some body), `ref.md` containing `[[old.md]]` and `[[old.md|Alias]]` and a `[[task:t1]]`. Call `notes.rename({ remote, from: 'old.md', to: 'sub/new.md' })`. Assert: `old.md` gone; `sub/new.md` present with the body; `ref.md` now contains `[[sub/new.md]]` and `[[sub/new.md|Alias]]` with `[[task:t1]]` untouched; return value `{ rewritten: [{ path: 'ref.md', count: 2 }] }`. Add a second test: renaming to an existing path throws `CONFLICT`.
- [ ] **Step 2: Run test, verify it fails** — `cd apps/desktop && pnpm exec vitest run test/router.test.ts`. Expected: FAIL — `notes.rename` is not a function.
- [ ] **Step 3: Implement** `notes.rename` per contract; import `rewriteWikiLinks`, `moveDocFile`, `scanBackrefs`.
- [ ] **Step 4: Run test, verify it passes.** Expected: PASS (both tests).
- [ ] **Step 5: Commit** — subject `feat(main): notes.rename moves the file and rewrites inbound links`.

---

## Task 5: `renameNoteAtom` (renderer state)

The renderer half of rename: flush, commit a clean restore point, call the proc, retarget any open tab, refresh the snapshot.

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/vaults.ts` (replace the "deliberately absent" comment ~line 160)
- Modify: `apps/desktop/src/renderer/src/state/panes.ts` (add a pure `retargetTab` helper if none fits)
- Test: `apps/desktop/test/panes.test.ts` (extend — the `retargetTab` unit test) and `apps/desktop/test/rename-state.test.ts` (create — the `renameNoteAtom` fake-holi test)

**Contract (`renameNoteAtom`, a write-only atom):** input `{ from: string; to: string }`. Sequence:
1. `await flushAllBuffers()` — the one live buffer reaches disk.
2. `await trpc.sync.commitNow.mutate()` — a restorable clean state before the multi-file edit.
3. `await trpc.notes.rename.mutate({ remote, from, to })`.
4. Retarget the workspace: every `Tab` with `kind === 'note' && path === from` becomes `path: to` (across all panes). If `activeDocAtom?.path === from`, update it to the `to` doc after the snapshot reload.
5. `await set(loadSnapshotAtom)` then `await trpc.sync.commitNow.mutate()` — the rename lands as one commit.
6. No-op (return) if `activeRemoteAtom` is null, matching `deleteNoteAtom`.

**Pure helper contract (`panes.ts`):** `export function retargetTab(w: Workspace, from: string, to: string): Workspace` — returns a new `Workspace` with matching note tabs' paths swapped, indices untouched (a rename doesn't reorder tabs).

- [ ] **Step 1: Write the failing test** for `retargetTab` (pure, no fake-holi) in `test/panes.test.ts`: a workspace with tabs `[{note a.md},{board},{note x.md}]` renamed `a.md`→`b.md` yields `[{note b.md},{board},{note x.md}]`, `active` unchanged; a rename of a path not open is a no-op.
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/panes.test.ts`. Expected: FAIL — `retargetTab` not exported.
- [ ] **Step 3: Implement `retargetTab`** in `panes.ts`.
- [ ] **Step 4: Run, verify pass.** Expected: PASS.
- [ ] **Step 5: Write the failing test** for `renameNoteAtom` in `test/rename-state.test.ts` using `installFakeHoli`: seed a `handle` that records each `op.path` (the tRPC procedure path) and returns plausible results; drive `renameNoteAtom({from,to})`; assert the recorded op sequence includes `sync.commitNow`, `notes.rename`, `sync.commitNow` in order (and that `flushAllBuffers` ran — assert via a registered flusher spy); assert the `workspaceAtom` tab retargeted; assert a null remote is a no-op.
- [ ] **Step 6: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/rename-state.test.ts`. Expected: FAIL — `renameNoteAtom` not exported.
- [ ] **Step 7: Implement `renameNoteAtom`** per contract; import `flushAllBuffers`, `retargetTab`, `workspaceAtom`.
- [ ] **Step 8: Run, verify pass.** Expected: PASS.
- [ ] **Step 9: Commit** — subject `feat(renderer): renameNoteAtom flushes, renames, retargets the open tab`.

---

## Task 6: `backrefsFor` (renderer state)

A thin, testable wrapper the delete dialog calls, so the fetch logic lives in `.ts`, not the component.

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/vaults.ts`
- Test: `apps/desktop/test/backrefs-state.test.ts` (create, fake-holi)

**Contract:** `export const backrefsFor = atom(null, async (get, _set, path: string): Promise<{ path: string; count: number }[]> => …)` — reads `activeRemoteAtom`, returns `[]` if null, else `trpc.notes.backrefs.query({ remote, path })`. (A write-only atom used purely as an async action, mirroring `loadSnapshotAtom`.)

- [ ] **Step 1: Write the failing test** with fake-holi: stub `notes.backrefs` to return `[{ path: 'a.md', count: 2 }]`; assert `backrefsFor('b.md')` resolves to it; assert `[]` when remote is null.
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/backrefs-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `backrefsFor`.**
- [ ] **Step 4: Run, verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — subject `feat(renderer): backrefsFor query wrapper`.

---

## Task 7: FileTree rename affordance (UI — CDP-verified)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx`
- Verify: `apps/desktop/cdp.mjs` against the running app (no unit test — component)

**Contract:** Each note row gets a rename control (a small `title="rename"` button beside the existing `title="delete"` one at `FileTree.tsx:128`, matching that pattern). Clicking prompts for a new vault-relative path, pre-filled with the current `node.path` (use `window.prompt` — the app is Electron; a richer inline-edit is out of scope). On a non-empty, changed value, call `renameNoteAtom({ from: node.path, to: value.endsWith('.md') ? value : value + '.md' })`, `.catch` surfacing the error the way `deleteNote(...).catch` already does (`FileTree.tsx:137`). Update the file's header comment (lines 9-11) — rename is no longer absent.

- [ ] **Step 1: Implement** the rename button + handler wired to `useSetAtom(renameNoteAtom)`.
- [ ] **Step 2: Build check** — `cd apps/desktop && pnpm exec electron-vite build`. Expected: succeeds (no new typecheck regressions in touched files).
- [ ] **Step 3: CDP-verify.** Launch the app (see `apps/desktop/verify-focus-pull.sh` for the local-bare-repo rig, no token needed). Create `a.md` and `ref.md` with `[[a.md]]`; rename `a.md` → `folder/b.md` via the tree; confirm with `cdp.mjs` that: the tree shows `folder/b.md`, `ref.md`'s content is `[[folder/b.md]]`, and the open tab (if `a.md` was active) now points at `folder/b.md`. Scope the process kill afterward: `pkill -f "better-holi-final/node_modules/.pnpm/electron@"`.
- [ ] **Step 4: Commit** — subject `feat(renderer): rename a note from the file tree`.

---

## Task 8: Delete backref-preview dialog (UI — CDP-verified)

Replace the bare `window.confirm(\`Delete ${node.path}?\`)` (`FileTree.tsx:136`) with a confirm that first fetches backrefs and names each linking file + its occurrence count (FR-12). No cascade — dangling refs survive as the existing missing-chip rendering.

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx`
- Verify: `cdp.mjs`

**Contract:** On delete-click: `const refs = await set(backrefsFor)(node.path)`. If `refs` is empty, keep a plain confirm ("Delete `<path>`? This cannot be undone."). If non-empty, the confirm body lists each `` `${r.path}` (${r.count}) `` and a total, with copy making clear the links will become tombstones, not be cascaded. On confirm → existing `deleteNote(node.path)`. Keep it a modal the extension won't choke on: prefer a small in-app dialog component over stacking multiple `window.confirm`s. (One `window.confirm` with a composed multi-line message is acceptable if a dialog component is disproportionate — but the message must enumerate the referrers.)

- [ ] **Step 1: Implement** the backref fetch + preview confirm, wired to `useSetAtom(backrefsFor)` and the existing `deleteNoteAtom`.
- [ ] **Step 2: Build check** — `cd apps/desktop && pnpm exec electron-vite build`. Expected: succeeds.
- [ ] **Step 3: CDP-verify.** With `ref.md` linking `[[a.md]]`, trigger delete on `a.md`; confirm the dialog names `ref.md (1)`. Cancel → `a.md` still present. Confirm → `a.md` gone, `ref.md` still contains the now-dangling `[[a.md]]` (renders as a missing chip). Scoped `pkill` after.
- [ ] **Step 4: Commit** — subject `feat(renderer): backref preview before deleting a note`.

---

## Task 9: Frontmatter widget (FR-2 hide + FR-16 reveal)

Frontmatter becomes one atomic block widget over the leading `---…---` region — collapsed to a pill by default (this *is* the missing FR-2 hide), click-to-expand into a raw-YAML editor (no markdown stack, so `⌘B` can't corrupt a key). Single file, single doc, single view — merge machinery untouched. A debounced YAML check drives a status dot and the save gate.

Sequenced last: the region/validity helpers (9a, 9b) are pure and unit-tested; the widget and save-gate wiring (9c, 9d) are CDP-verified.

### Task 9a: `frontmatterRegion` pure helper

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/frontmatter-region.ts`
- Test: `apps/desktop/test/frontmatter-region.test.ts` (create)

**Contract:** `export function frontmatterRegion(doc: string): { from: number; to: number } | null` — offsets of the leading fence block (from `0` through the newline after the closing `---`), or `null` if the doc doesn't start with `---\n` or the fence is unterminated. **Text-based** — do NOT use the Lezer tree (GFM has no frontmatter node). Reuse the fence-scan shape from `splitFrontmatter` so hide and parse agree.

- [ ] **Step 1: Write the failing test.** Cases: doc with a fence → correct `{from:0, to:N}` covering `---\n…\n---\n`; doc with no leading fence → `null`; doc starting `---` but never closing → `null`; a `---` thematic break mid-body (not at offset 0) → `null`.
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/frontmatter-region.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `frontmatterRegion`.**
- [ ] **Step 4: Run, verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — subject `feat(renderer): frontmatterRegion detects the leading fence`.

### Task 9b: `frontmatterYamlValid` pure helper

**Files:**
- Modify: `apps/desktop/src/renderer/src/editor/frontmatter-region.ts`
- Test: `apps/desktop/test/frontmatter-region.test.ts` (extend)

**Contract:** `export function frontmatterYamlValid(doc: string): boolean` — `splitFrontmatter(doc)` (from `@holi/shared`) then `parse` from `yaml` in a try/catch. `true` when there is no fence (`yaml === null` — nothing to be invalid) or the YAML parses; `false` on a parse throw. This is the *exact* gate the downstream parsers apply, so the dot never disagrees with what they'll accept.

- [ ] **Step 1: Write the failing test.** Cases: valid frontmatter → `true`; `tags: [` (unterminated flow) → `false`; a tab-indented map (YAML rejects tabs) → `false`; no fence → `true`.
- [ ] **Step 2: Run, verify fail.** Expected: FAIL.
- [ ] **Step 3: Implement `frontmatterYamlValid`** using `splitFrontmatter` + `yaml`'s `parse`.
- [ ] **Step 4: Run, verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — subject `feat(renderer): frontmatterYamlValid mirrors the downstream YAML gate`.

### Task 9c: The widget + decoration + validity StateField (UI — CDP-verified)

**Files:**
- Create: `apps/desktop/src/renderer/src/editor/frontmatter.ts`
- Modify: `apps/desktop/src/renderer/src/editor/extensions.ts` (add to `baseEditorExtensions`)
- Verify: `cdp.mjs`

**Contract:**
- A `StateField<{ expanded: boolean; valid: boolean }>` per view. `expanded` starts `false`; toggled by a `StateEffect` the widget's DOM dispatches (pill click ↔ collapse control). `valid` recomputed (debounced ~300ms, or synchronously on the frontmatter range changing) via `frontmatterYamlValid(view.state.doc.toString())`.
- A `Decoration.replace({ widget, block: true })` over `frontmatterRegion(doc)` when it is non-null. Collapsed widget = a compact pill (e.g. `▸ frontmatter · N fields`) + status dot (green `valid`, red `!valid`). Expanded widget = the pill/header (collapse control + dot) above a **nested minimal editing surface** for the raw YAML.
  - The nested surface edits the *same* frontmatter bytes. Simplest faithful approach: the widget does not host a second document — clicking "expand" makes the decoration **reveal the raw range** (stop replacing it) so the underlying text is edited directly, but with a **YAML-only visual treatment and no markdown/formatting keymap active inside the range**. The atomic-range + reveal pattern is exactly what live-preview already does for the active line (`livePreview.ts`); mirror it. This keeps one document and sidesteps nested-editor/parent-doc sync entirely. (If a genuinely separate mini-editor is later wanted, it is a follow-up — not this task.)
- Expose a selector `export function frontmatterValid(state: EditorState): boolean` reading the StateField, for the save gate (Task 9d).
- Register the extension in `baseEditorExtensions` (`extensions.ts`) after `livePreview` so the frontmatter replace wins over ordinary decorations on those lines.

**Gotchas:** frontmatter must not be double-hidden or fight live-preview on the same lines — the frontmatter decoration owns offsets `[0, region.to)`; ensure `livePreview` skips that range (it walks the syntax tree, which has no frontmatter node, so it likely emits nothing there — verify in CDP that no stray heading/HR decoration lands on the `---`). The reveal-on-expand must not also trigger the active-line raw reveal in a way that flickers.

- [ ] **Step 1: Implement** `frontmatter.ts` (StateField + toggle effect + widget + decoration + `frontmatterValid` selector) and register it in `extensions.ts`.
- [ ] **Step 2: Build check** — `cd apps/desktop && pnpm exec electron-vite build`. Expected: succeeds.
- [ ] **Step 3: CDP-verify.** Open a note whose body starts with a valid `---\ntitle: x\n---` block. Confirm: frontmatter renders as a collapsed pill with a green dot, body below is normal; click the pill → raw YAML revealed and editable, no markdown chrome; type `tags: [` → dot goes red; fix it → dot green; collapse again. Use `cdp.mjs --type` for input (the EditorView is unreachable from JS — handoff §5). Scoped `pkill` after.
- [ ] **Step 4: Commit** — subject `feat(renderer): frontmatter as a collapsible in-editor widget (FR-2/FR-16)`.

### Task 9d: Save gate on frontmatter validity

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/EditorPane.tsx` (the `save` closure, ~lines 77-84, and the ⌘S handler ~line 118)
- Verify: `cdp.mjs`

**Contract:** In `save()`, before writing, consult `frontmatterValid(viewRef.current.state)`. If invalid, **return without writing** (idle autosave and ⌘S both hold off — ⌘S becomes a no-op that leaves the dot red). The **unmount/flush** path (`EditorPane.tsx:141-146`) writes **regardless** — losing keystrokes is worse than a note with temporarily-bad YAML, and git has it either way (the decision recorded during grilling). So: gate the shared `save()`; do **not** add the gate to the cleanup-time write.

**Gotcha:** the ⌘S handler currently does `save().then(() => sync.commitNow())`. When `save()` held off (invalid), it must **not** commit — otherwise ⌘S commits stale/again. Have `save()` return a boolean (`wrote`), and only `commitNow()` when it wrote.

- [ ] **Step 1: Implement** the gate: `save()` returns `Promise<boolean>`; guards on `frontmatterValid`; ⌘S only commits when `save()` returned `true`; the cleanup write stays unconditional.
- [ ] **Step 2: Build check** — `cd apps/desktop && pnpm exec electron-vite build`. Expected: succeeds.
- [ ] **Step 3: CDP-verify.** Open a note; break the frontmatter (`tags: [`); wait past the autosave debounce → confirm on disk the file is unchanged (autosave held off); press ⌘S → still unchanged; fix the YAML → autosave now writes. Then break it again and close the tab → confirm the flush *did* write (edits not lost). Scoped `pkill` after.
- [ ] **Step 4: Commit** — subject `feat(renderer): hold autosave and ⌘S while frontmatter YAML is invalid`.

---

## Self-review checklist (run before handing off to execution)

- **Spec coverage:** FR-16 frontmatter reveal → Task 9 (a–d). FR-2 frontmatter hide (found unbuilt) → Task 9c. FR-11 rename+move+link-rewrite → Tasks 4, 5, 7. FR-12 backref preview before delete → Tasks 2, 3, 6, 8. Task-chips FR-6/8 → **out of scope by decision** (sequence with tasks work). Preview/pinned tabs, daily, history → **plan 7, not here.**
- **Router surface added:** `notes.backrefs` (Task 3), `notes.rename` (Task 4). Shared export added: `splitFrontmatter` (Task 1). State atoms added: `renameNoteAtom`, `backrefsFor` (Tasks 5, 6). Pure helpers: `retargetTab`, `scanBackrefs`, `frontmatterRegion`, `frontmatterYamlValid`, `frontmatterValid` selector.
- **Type consistency:** `{ path: string; count: number }[]` is the one backref shape across Tasks 2/3/6/8. `renameNoteAtom` takes `{ from, to }`; `notes.rename` input is `{ remote, from, to }`. `save()` returns `boolean` after Task 9d — no earlier task depends on its old `void`.
- **No new merge risk:** every frontmatter task keeps one document/one view; `base`/`mine`/`disk` untouched. Confirm during 9c CDP that an external write to a note with frontmatter still reloads/merges as before.
- **Optional deeper check:** hand this plan to a fresh agent via `plan-document-reviewer-prompt.md` before executing Task 9 (the exploratory one).
