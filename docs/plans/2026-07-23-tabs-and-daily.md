# Preview/Pinned Tabs + Daily Notes Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two well-specified halves of "plan 7" — VS Code's preview-vs-pinned tab model (the `notes-editor.md` FR-15 remainder) and daily notes (`daily-notes.md`, all 6 FRs) — leaving history out (see Scope).

**Architecture:** Preview/pinned is pure renderer state on the existing `panes[]→tabs[]` shape: a `preview` flag on note tabs, promoted to pinned by double-click or by editing. Daily notes are `if (!exists) write(seed)` at the vault root plus an on-open sweep that archives prior days into `journal/` (reusing the `notes.rename` link-rewriting move built in the notes-editor-gaps plan) and GCs untouched, unreferenced stubs — all path-based and offline-complete, with the shared predicates (`buildDailyNoteContent`, `isDailyNote`, `isUntouchedDailyNote`) already ported.

**Tech stack:** TypeScript, tRPC, Jotai, CodeMirror 6, Vitest 4, real git.

**House style:** Lean — contracts, signatures, assertion lists, gotchas; **not** full inline implementations. Test steps give assertion bullets + exact commands.

---

## Scope

**In:** preview/pinned tabs (Part A), daily notes create + sweep + navigation (Part B).

**Out — history, deliberately.** There is **no history PRD**, and `architecture.md` is explicit that a version-history subsystem does not exist post-pivot: "Its history is git history" (§Vault), "There are no snapshots to store" (§Durability), "the commit journal *is* the undo history" (§Sync). The quarantined `state/history.ts` + `HistoryPanel.tsx` call a `trpc.snapshots.*` router against a server DB that is gone; reviving them as a git-log panel would be **inventing** an unspecified feature. History needs a product decision (is an in-app version panel a v1 feature at all, or is `git log` / Claude Code `--resume` the answer?) before it is planned — it is not in this plan.

**Deferred within Part B (flagged, not silently dropped):**
- **Task-count badge (`daily-notes.md` FR-6 partial).** The "Today" entry's open-task count is coupled to the tasks surface (unverified in-app) and to open-question #1 (links-to vs due-today). Deferred to sequence with task work. The rest of FR-6 (sidebar Today, shortcut) is in.

**Open questions resolved by decision (flagged at their tasks):**
- **Personal-vault detection (`daily-notes.md` OQ#2).** Resolved: **a vault is personal unless positively known to have >1 GitHub collaborator.** Checked opportunistically via the existing `github.collaborators` proc, cached per session; offline/unchecked ⇒ treated as personal (the common case, and offline-complete). Known >1 collaborator ⇒ no daily auto-create.
- **Daily shortcut.** Resolved: **⌘⇧D** ("daily"). Avoids the reopen-closed-tab `⌘⇧T`; the Shell's "no ⌘J" note is specifically about a non-existent agent drawer, not a blanket ban.
- **Tab persistence across restart (`notes-editor.md` OQ).** Resolved: **not persisted in v1** — matches today's non-persisted `workspaceAtom`. Persistence to `.holi/settings.local.json` is a later, additive change.
- **Board tab preview state.** Resolved: **the board tab is always pinned** (it is unique — there is nothing to "preview-replace" it with).

---

## Conventions & gotchas

- **Bare `node`/`npx` broken — use `pnpm exec`.** Shell cwd resets between Bash calls; use absolute paths or `cd` each time.
- **Tests:** desktop `cd apps/desktop && pnpm exec vitest run <file>`; shared `cd packages/shared && pnpm exec vitest run <file>`. `fileParallelism:false` + `testTimeout:20_000` already set.
- **Renderer state tests** are node-env `.ts`, driven by `test/helpers/fake-holi.ts` — `installFakeHoli(handle)` services `window.holi.trpc(op)` by `op.path`; `holi.calls` records ops. Copy `test/vaults-state.test.ts` / `test/panes.test.ts`. Test files are **flat** in `apps/desktop/test/`.
- **UI verification ceiling:** the whole UI is behind the sign-in gate and the keychain is signed-out, so component behavior (tab clicks, the Today entry) can only be **built + boot-checked**, not visually driven; router procs are verifiable trpc-level over `cdp.mjs` against a local bare-repo vault (see `verify-focus-pull.sh`, and the `holi-ui-verification-ceiling` memory). Add each unverifiable-in-CI check to `docs/verification/2026-07-23-tabs-and-daily.md` (create it — mirror the notes-editor one).
- **`electron-vite` resolves imports without typechecking** — a boot-path break fails silently at window-open. Boot-check after wiring.
- **`codemirror-markdown-tables` is unimportable under vitest** (transitive `@mobily/ts-belt` ESM dir-import). Editor tests import only pure pieces, never `editor/extensions.ts`.
- **Commit message trailer:** end each body with `Claude goes brr.. via Dash`. Multi-line messages via a file + `git commit -F` (backticks in `-m` heredocs get shell-substituted).

---

## File structure

**Renderer state**
- Modify `renderer/src/state/panes.ts` — `preview` flag on note tabs; `openPreview`, `openPinned`, `pinTab`, `pinActive` pure functions.
- Rewrite `renderer/src/state/daily.ts` — path-based `openTodaysDailyAtom`, `sweepDailyAtom`, `isPersonalVault`. (Currently dead: calls `notes.getOrCreateDaily`/`sweepDaily` with the old `vault.id`/`docId` model.)

**Renderer components**
- Modify `renderer/src/components/Shell.tsx` — single-click→preview, double-click→pinned, tab double-click→pin, edit→pin; the "Today" sidebar entry; ⌘⇧D; on-personal-open create+sweep.
- Modify `renderer/src/components/FileTree.tsx` — `onOpenPreview`/`onOpenPinned` (single vs double click on a row).
- Modify `renderer/src/components/EditorPane.tsx` — an `onEdit` callback fired on first doc change (drives edit→pin promotion).

**Main**
- Create `renderer`… no. **Create `main/vault/rename.ts`** — extract `renameNote(root, from, to)` (the scan+rewrite+move core) from `router.ts` so `notes.rename` and the daily sweep share one link-rewriting move.
- Create `main/vault/daily.ts` — `getOrCreateDaily(root, today)`, `sweepDaily(root, today)`.
- Modify `main/router.ts` — `notes.getOrCreateDaily`, `notes.sweepDaily`; point `notes.rename` at the extracted helper.

**Shared:** none new — `daily-note.ts` predicates already exist. A local-date `todayLocal()` already lives in `router.ts` (`localToday`); reuse the router's `today` dep.

---

## Part A — Preview/Pinned Tabs

### Task A1: `preview` flag + pure tab transitions in `panes.ts`

**Files:**
- Modify: `apps/desktop/src/renderer/src/state/panes.ts`
- Test: `apps/desktop/test/panes.test.ts` (extend)

**Contract:**
- `Tab` becomes `{ kind: 'note'; path: string; preview?: boolean } | { kind: 'board' }`. `preview` absent/false ⇒ pinned. The board tab is never preview.
- `openPreview(w, path): Workspace` — (a) if a note tab for `path` is already open in the active pane, focus it, unchanged; (b) else if the active pane has a preview note tab, **replace it in place** with `{kind:'note',path,preview:true}` (same index) and make it active; (c) else append `{kind:'note',path,preview:true}` and make it active. This is what makes browsing cost one tab.
- `openPinned(w, path): Workspace` — if open, focus it and clear its `preview`; else append `{kind:'note',path}` (pinned) and make active.
- `pinTab(w, index): Workspace` — clear `preview` on the tab at `index` in the active pane (no-op if already pinned or out of range).
- `pinActive(w): Workspace` — `pinTab(w, activeIndex)`; the edit-promotes-preview rule.
- `openTab`/`retargetTab`/`closeTab`/`activeTab` keep working; `retargetTab` must **preserve `preview`** (spread the old tab: `{ ...tab, path: to }`, not a fresh `{kind:'note',path:to}`). The **board tab** keeps opening via the existing `openTab({kind:'board'})` — it has no `preview` flag, so it is pinned by construction; no `openPinned` for board.

- [ ] **Step 1: Write the failing tests.** In `panes.test.ts`: (a) `openPreview` twice on different paths yields **one** tab (the second replaced the first), active; (b) `openPreview` on an already-open path focuses it and does not duplicate; (c) `openPinned` then `openPreview` of a third path keeps the pinned one and adds a preview (two tabs); (d) `pinActive` clears `preview` on the active tab; (e) `openPinned` on an existing preview tab pins it in place (still one tab, `preview` false).
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/panes.test.ts`. Expected: FAIL — functions not exported.
- [ ] **Step 3: Implement** the flag + four functions.
- [ ] **Step 4: Run, verify pass.** Expected: PASS (existing panes tests still green).
- [ ] **Step 5: Commit** — `feat(renderer): preview/pinned tab transitions in panes`.

### Task A2: EditorPane fires `onEdit` on first change

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/EditorPane.tsx`
- Verify: build + boot (component)

**Contract:** `EditorPane` gains an optional `onEdit?: () => void` prop, called the **first** time the buffer changes for a given `path` (guard with a ref so it fires once per open, not per keystroke). Wired from the existing `updateListener` that already calls `scheduleSave()` on `docChanged`.

- [ ] **Step 1: Implement** the `onEdit` prop + fire-once ref in the `updateListener`.
- [ ] **Step 2: Build check** — `cd apps/desktop && pnpm exec electron-vite build`. Expected: succeeds.
- [ ] **Step 3: Commit** — `feat(renderer): EditorPane signals the first edit`.

### Task A3: Wire preview/pinned into Shell + FileTree (UI — boot-checked)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/FileTree.tsx`
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx`
- Verify: build + boot; add checks to `docs/verification/2026-07-23-tabs-and-daily.md`

**Contract:**
- FileTree row: **single-click** → `onOpenPreview(path)`; **double-click** → `onOpenPinned(path)`. (Add `onDoubleClick` beside the existing `onClick`; keep the rename/delete controls.)
- Shell: `open` (single) → `setWorkspace(w => openPreview(w, path))`; a new `openPinned` handler for double-click on a note row; the tab strip renders a **preview tab's title in italic**; **double-clicking a tab** → `setWorkspace(w => pinTab(w, i))`; the `EditorPane` gets `onEdit={() => setWorkspace(pinActive)}`.
- The board tab keeps opening via `openTab({kind:'board'})` (pinned by construction — no `preview` flag).

- [ ] **Step 1: Implement** the FileTree prop split + Shell wiring (italic preview title, tab double-click pin, edit-pin).
- [ ] **Step 2: Build check** — Expected: succeeds.
- [ ] **Step 3: Boot check** — launch dev app (signed-out is fine), confirm `#root` renders and no renderer errors (the tab code is behind sign-in, so this only proves boot-safety). Scoped `pkill` after.
- [ ] **Step 4: Record** the visual checks (single-click reuses one tab, double-click/edit pins, italic preview) in the verification doc as unverified.
- [ ] **Step 5: Commit** — `feat(renderer): preview-vs-pinned tabs in the shell`.

---

## Part B — Daily Notes

### Task B1: Extract `renameNote` main helper

So the daily archive move and `notes.rename` share one link-rewriting move (DRY; `daily-notes.md` §Archiving (c) — "no bespoke daily-archive rewrite path").

**Files:**
- Create: `apps/desktop/src/main/vault/rename.ts`
- Modify: `apps/desktop/src/main/router.ts` (point `notes.rename` at it)
- Test: `apps/desktop/test/rename-helper.test.ts` (create)

**Contract:** `export async function renameNote(root: string, from: VaultRelPath, to: VaultRelPath): Promise<{ rewritten: { path: string; count: number }[] }>` — the exact body currently inline in `notes.rename`: `scanBackrefs` → for each referrer read + `rewriteWikiLinks` + `writeAtomic` → `moveDocFile`. Does **not** check existence or commit (callers own those). `notes.rename` keeps its `exists(to)` CONFLICT guard and then delegates.

- [ ] **Step 1: Write the failing test.** In `rename-helper.test.ts`: build a temp vault (`old.md`, `ref.md` with `[[old.md]]`×2), call `renameNote(root, 'old.md', 'sub/new.md')`, assert the file moved, `ref.md` rewritten, and `{ rewritten: [{path:'ref.md',count:2}] }`.
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/rename-helper.test.ts`. Expected: FAIL — module missing.
- [ ] **Step 3: Implement** `renameNote`; refactor `notes.rename` in `router.ts` to `const out = ...; if (await exists(root, to)) throw CONFLICT; return renameNote(root, from, to)`.
- [ ] **Step 4: Run, verify pass** — the new test AND `test/router.test.ts` (the rename tests must still pass). Expected: PASS.
- [ ] **Step 5: Commit** — `refactor(main): extract renameNote so the daily sweep can reuse it`.

### Task B2: `getOrCreateDaily` + `sweepDaily` main helpers

**Files:**
- Create: `apps/desktop/src/main/vault/daily.ts`
- Test: `apps/desktop/test/daily.test.ts` (create)

**Contract (`daily.ts`):**
- `getOrCreateDaily(root, todayIso): Promise<{ path: string; created: boolean }>` — `rel = dailyNoteFilename(todayIso)` (= `DD-MM-YYYY.md`) at root. If it exists, `{path, created:false}`; else `writeAtomic(root, rel, buildDailyNoteContent(todayIso))`, `{path, created:true}`. Byte-for-byte deterministic (FR-3 idempotency).
- `sweepDaily(root, todayIso): Promise<{ archived: number; deleted: number }>` — for each **root-level** `.md` (no `/` in path) whose content `isDailyNote` and whose path ≠ today's:
  - if `isUntouchedDailyNote(content, dailyNoteStem(...))` **and** `scanBackrefs(root, path)` is empty → delete (`removeDocFile`), `deleted++`.
  - else → `renameNote(root, path, 'journal/' + basename)` (archive move with link rewrite), `archived++`.
  - Selection is by **`type: daily-note` frontmatter, never filename** (`daily-notes.md` §Archiving — a hand-authored date-named note must not be swept). Idempotent: `journal/` dailies aren't at root, so a re-run is a no-op directory listing.
  - The stem for the untouched check comes from the file's own date, derived from its content/filename; use `isDailyNoteFilename` only to find the stem to compare, not to select.

- [ ] **Step 1: Write the failing tests.** `getOrCreateDaily`: creates when absent (`created:true`, content === `buildDailyNoteContent(iso)`), returns existing untouched (`created:false`). `sweepDaily`: (a) an untouched, unreferenced prior-day daily is **deleted**; (b) a prior-day daily **with body text** is **archived** to `journal/` (file moved); (c) an untouched prior-day daily that **is linked** from another note is **archived, not deleted** (backref guard); (d) **today's** daily is left at root; (e) a hand-authored `31-12-1999.md` with **no `type: daily-note`** frontmatter is left untouched; (f) re-running the sweep is a no-op.
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/daily.test.ts`. Expected: FAIL — module missing.
- [ ] **Step 3: Implement** `getOrCreateDaily` + `sweepDaily`, reusing `renameNote`, `scanBackrefs`, and the shared daily predicates.
- [ ] **Step 4: Run, verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(main): daily-note create + sweep (archive + stub GC)`.

### Task B3: `notes.getOrCreateDaily` + `notes.sweepDaily` router procs

**Files:**
- Modify: `apps/desktop/src/main/router.ts`
- Test: `apps/desktop/test/router.test.ts` (extend)

**Contract:**
- `notes.getOrCreateDaily`: mutation, input `{ remote }`, returns `{ path, created }` — `getOrCreateDaily(await rootFor(remote), today())` (the router's existing `today` dep — local date).
- `notes.sweepDaily`: mutation, input `{ remote }`, returns `{ archived, deleted }` — `sweepDaily(rootFor(remote), today())`. Does **not** commit (the renderer commits once after, `daily-notes.md` §Archiving "single commit").
- No personal-vault check here — the renderer gates (it owns the `github.collaborators` call).

- [ ] **Step 1: Write the failing tests** in `router.test.ts` via `rig(...)`: `getOrCreateDaily` on an empty vault creates today's `DD-MM-YYYY.md` (`created:true`) using the rig's fixed `TODAY`; a second call returns `created:false`. `sweepDaily` with a seeded prior-day untouched daily returns `{archived:0, deleted:1}`.
- [ ] **Step 2: Run, verify fail** — Expected: FAIL — procs not functions.
- [ ] **Step 3: Implement** both procs.
- [ ] **Step 4: Run, verify pass** — the new tests + full `router.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(main): notes.getOrCreateDaily and notes.sweepDaily`.

### Task B4: Rewrite `daily.ts` renderer state (path-based)

**Files:**
- Rewrite: `apps/desktop/src/renderer/src/state/daily.ts`
- Test: `apps/desktop/test/daily-state.test.ts` (replace its dead contents)

**Contract:**
- `isPersonalVault(remote): Promise<boolean>` — `(await trpc.github.collaborators.query({remote})).collaborators.length <= 1`; on any error (offline, not signed in) → `true` (default personal). **Note the proc returns `{visibility, collaborators}` (router.ts) — read `.collaborators`, not the top-level result.** No cache in v1 (it is one call per vault open, not per render — a per-session cache is a later optimization; skipping it also keeps the module free of cross-test state). **This resolves `daily-notes.md` OQ#2 (flagged in Scope).**
- `openTodaysDailyAtom` (write-only) — `remote = activeRemoteAtom`; return null if none. If `!(await isPersonalVault(remote))` return null (no daily in shared vaults, FR-4). Else `{path, created} = trpc.notes.getOrCreateDaily({remote})`; if `created` `await set(loadSnapshotAtom)`; `set(workspaceAtom, openPinned(get(workspaceAtom), path))`; `set(activeDocAtom, snapshot doc for path)`; return path.
- `sweepDailyAtom` (write-only) — `remote`; if `!(await isPersonalVault(remote))` return; `{archived, deleted} = trpc.notes.sweepDaily({remote})`; if `archived||deleted` → `await set(loadSnapshotAtom)` then `trpc.sync.commitNow.mutate()` (the single sweep commit).
- Delete every `vault.id`/`docId`/`loadDocsAtom`/`activeVaultIdAtom` reference (dead model).

- [ ] **Step 1: Write the failing tests** with `installFakeHoli`: (a) `openTodaysDaily` on a personal vault (`github.collaborators` → 1 collaborator) calls `notes.getOrCreateDaily`, opens a pinned tab for the returned path; (b) on a shared vault (2 collaborators) it does **not** call `getOrCreateDaily` and returns null; (c) `github.collaborators` throwing ⇒ treated as personal (still creates); (d) `sweepDaily` with `{archived:1}` triggers `loadSnapshot` + `sync.commitNow`, with `{archived:0,deleted:0}` triggers neither.
- [ ] **Step 2: Run, verify fail** — `cd apps/desktop && pnpm exec vitest run test/daily-state.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the rewrite.
- [ ] **Step 4: Run, verify pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `feat(renderer): daily-note state, path-based and personal-gated`.

### Task B5: Shell navigation — Today entry, ⌘⇧D, on-open create+sweep (UI — boot-checked)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx`
- Verify: build + boot + trpc-level e2e; verification doc

**Contract:**
- On active-vault change (a Shell effect keyed on `activeRemote`): `void set(openTodaysDailyAtom)` then `void set(sweepDailyAtom)` — create+land, then sweep. Both no-op for shared vaults. Guard against re-running for the same remote.
- A **"Today"** sidebar entry (rendered only when the vault is personal — reuse the resolved `isPersonalVault`, or always render and let the atom no-op) → `openTodaysDailyAtom`.
- **⌘⇧D** global shortcut → `openTodaysDailyAtom` (add to Shell's keydown; guard against input focus if needed).
- Empty-state recovery: when panes reach zero tabs, the existing empty state offers "Open today's daily note" → `openTodaysDailyAtom`.

- [ ] **Step 1: Implement** the effect, the Today entry, ⌘⇧D, and the empty-state CTA.
- [ ] **Step 2: Build check** — Expected: succeeds.
- [ ] **Step 3: trpc-level e2e** — extend the local-bare-repo rig (a `verify-tabs-daily.sh` in scratchpad, modeled on `verify-notes-gaps.sh`): adopt a vault, call `notes.getOrCreateDaily` → assert `DD-MM-YYYY.md` appears at root with the seed; seed a prior-day untouched daily + a prior-day daily with body, call `notes.sweepDaily` → assert the stub is gone and the other moved to `journal/`. (This proves the procs in the real main process; the Shell wiring itself is behind sign-in.)
- [ ] **Step 4: Boot check** + record the sign-in-gated visual checks (Today entry, ⌘⇧D, land-on-open) in `docs/verification/2026-07-23-tabs-and-daily.md`.
- [ ] **Step 5: Commit** — `feat(renderer): today's daily note on open, sidebar entry, and shortcut`.

---

## Self-review checklist

- **Spec coverage — tabs:** FR-15 preview/pinned → A1 (transitions) + A3 (wiring); the "tab is not a note" union is preserved (A1 keeps the discriminated union). Split panes remain deferred (shape already `panes[]→tabs[]`).
- **Spec coverage — daily:** FR-1 path shape / FR-2 filename / FR-3 seed → B2 (shared predicates reused). FR-4 auto-create on personal open → B3 + B4 + B5. FR-5 stub GC + archive → B2 `sweepDaily`. FR-6 navigation → B5 (Today + shortcut; **badge deferred**, flagged). Idempotency/timezone → the router's local `today` dep + deterministic seed. Personal-only → B4 `isPersonalVault`.
- **History:** explicitly **out** (Scope) — no task, by decision.
- **DRY:** the archive move reuses `renameNote` (B1), not a second rewrite path. `scanBackrefs` is the one backref grep (delete guard + sweep guard). No duplicated daily predicates (shared).
- **Type consistency:** `{ path: string; created: boolean }` (getOrCreateDaily) and `{ archived: number; deleted: number }` (sweepDaily) are stable across B2/B3/B4. `Tab.preview?: boolean` is the one flag across A1/A3. `renameNote` returns the same `{ rewritten }` shape `notes.rename` returned.
- **Verification honesty:** every UI task is build + boot only (sign-in ceiling); every router proc is trpc-level e2e'd. Unverifiable-in-CI checks go into the verification doc, not claimed as done.
