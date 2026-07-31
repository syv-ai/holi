# Version History Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the open note a version timeline over `git log --follow` — list, read-only preview, and restore — mounted as a right-hand drawer, retiring the dead CRDT-snapshot code (and with it the 6 baseline typecheck errors).

**Architecture:** No snapshot store; git's object store *is* the history (D60, `prd/vaults-sync.md` §History). A new `git.show(sha, path)` primitive reads a file at a past commit; a `history` tRPC sub-router exposes list/preview/restore; the renderer's `state/history.ts` is rewritten off the deleted server `snapshots` API onto commits keyed by **path** (D60 killed `DocMeta.id`). The existing `HistoryPanel.tsx` is reused with renamed fields. Restore **writes the old content as a new commit — never a history rewrite** (PRD §History).

**Tech Stack:** Electron main, TypeScript, Vitest, tRPC-over-IPC, Jotai, the `git.ts` engine (`repo.log`/`commitNow`), lucide-react.

---

## Conventions & gotchas (read once)

- **Tooling:** bare `node`/`npx` broken — always `pnpm exec`. Desktop commands from `apps/desktop/`. **Bash cwd drifts** — absolute `cd` every command.
- **Typecheck gate:** from `apps/desktop`, `pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"`. Baseline is **6 today, all in `state/history.ts`** — this plan **drives it to 0** (Task 3). After Task 3, *any* error is a regression.
- **Test baselines:** desktop **666** (`cd apps/desktop && pnpm exec vitest run`; backgrounded, exceeds 120s — parse the JSON reporter with `python3`), shared **187**. New/rewritten tests move these.
- **The clock frame is not involved here** — git author dates are ISO instants; the panel formats them, never re-sorts (`repo.log` is newest-first).
- **`repo.log` already `--follow`s renames** (`git.ts` `log()`), so the timeline follows a moved file for free. **`show`/preview does not** — it reads `<sha>:<current-path>`, which is absent at commits from before a rename (accepted v1 limitation; surface it, don't crash).
- **Restore under an open buffer:** the note may be open with unsaved edits. The renderer restore path **flushes buffers first** so the editor's external-write reconcile (`lib/editor-reload.ts`, clean buffer → silent reload) picks up the restored content without a spurious merge.
- **`safe(path)`** is the router's path-traversal guard — every `history` procedure uses it, like `notes.*`.

## Out of scope (explicit — do NOT build here)

- **A labeled `Restore <path> from <sha>` landmark commit.** There is no custom-message commit path on the vault host today (`commitNow()` writes `Update <path>`). Restore lands as a normal `Update` commit for v1; the landmark label is a deferred refinement. *(Noted in Task 2.)*
- **The agent's floating open-widget.** A separate redesign of how `AgentPanel` opens (⌘J stays as-is). Touch nothing about the agent here.
- **Renamed-file preview before the rename** (see gotcha).

## File structure

- `apps/desktop/src/main/git.ts` — **modify:** add `show(sha, path)` to `GitRepo` + impl.
- `apps/desktop/src/main/router.ts` — **modify:** add a `history` sub-router (list/preview/restore), register in the app router.
- `apps/desktop/src/renderer/src/state/history.ts` — **rewrite:** Commit-based, path-keyed; pure `partitionVersions`/`versionLabel` reducers; load/preview/restore/reset atoms.
- `apps/desktop/src/renderer/src/components/HistoryPanel.tsx` — **modify:** rename fields to the `Version` shape; reword the restore confirm.
- `apps/desktop/src/renderer/src/components/Shell.tsx` — **modify:** mount `<HistoryPanel/>`; add the header History button (toggles `historyOpenAtom`).
- Tests: `apps/desktop/test/git.test.ts`, `apps/desktop/test/router.test.ts`, `apps/desktop/test/history-state.test.ts`.

---

### Task 1: `git.show(sha, path)` — read a file at a past commit

**Files:**
- Modify: `apps/desktop/src/main/git.ts` (`GitRepo` interface + impl next to `log`)
- Test: `apps/desktop/test/git.test.ts`

**Contract:**
```ts
// on GitRepo:
show(sha: string, path: string): Promise<string>   // raw file content at that commit
```
Impl: run `git show <sha>:<path>` and return **raw stdout** (this is blob content, not porcelain — capturing it raw does not violate "parse only plumbing"). A path absent at that commit makes `git show` fail — let it **reject** (a `GitError` from `runGit`); callers decide how to present "unavailable at this version". Do **not** `--follow` (git show has no such notion); read the current path as given.

- [ ] **Step 1: Write the failing test** in `git.test.ts` (mirror the `makeRemote`/`makeClone`/`commitFile` fixture pattern already used there). A `describe('show', …)` with:
  - commit `note.md` = `"v1\n"`, capture its sha via `repo.log({ path:'note.md', limit:1 })[0].sha`; commit `note.md` = `"v2\n"`; assert `await repo.show(v1sha, 'note.md')` equals `"v1\n"` and `show(HEADsha,'note.md')` equals `"v2\n"`.
  - assert `repo.show(HEADsha, 'no-such-file.md')` **rejects** (`await expect(...).rejects.toThrow()`).

- [ ] **Step 2: Run → FAIL** — `cd apps/desktop && pnpm exec vitest run test/git.test.ts` (`show` is not a function).

- [ ] **Step 3: Implement** `show` on `GitRepo` and in the `openRepo` factory, beside `log`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/git.ts apps/desktop/test/git.test.ts
git commit -m "feat(git): show(sha, path) — read a file's content at a past commit

Claude goes brr.. via Dash"
```

---

### Task 2: `history` tRPC sub-router — list / preview / restore

**Files:**
- Modify: `apps/desktop/src/main/router.ts` (new `const history = t.router({...})`, added to the app router alongside `notes`, `sync`, etc.)
- Test: `apps/desktop/test/router.test.ts`

**Contract:**
```ts
const HISTORY_LIMIT = 200
const history = t.router({
  // The open file's commit timeline, newest-first, following renames.
  list: t.procedure
    .input(fields({ path: 'string' }))
    .query(({ input }): Promise<Commit[]> =>
      activeOrThrow().repo.log({ path: safe(input.path), limit: HISTORY_LIMIT })),

  // The file's content at one commit. NOT_FOUND when the path is absent there.
  preview: t.procedure
    .input(fields({ path: 'string', sha: 'string' }))
    .query(async ({ input }): Promise<{ text: string }> => {
      const text = await activeOrThrow().repo.show(input.sha, safe(input.path)).catch(() => null)
      if (text === null) throw new TRPCError({ code: 'NOT_FOUND', message: 'version unavailable' })
      return { text }
    }),

  // Restore = write the old content as a NEW commit. Never a history rewrite.
  restore: vaultMutation
    .input(fields({ remote: 'string', path: 'string', sha: 'string' }))
    .mutation(async ({ input }) => {
      const root = await rootFor(input.remote)
      const rel = safe(input.path)
      const text = await activeOrThrow().repo.show(input.sha, rel)
      await writeAtomic(root, rel, text)
      await activeOrThrow().commitNow()      // lands "Update <path>" now (see out-of-scope re: label)
      return { ok: true as const }
    }),
})
```
Register it in the app-router object next to the existing sub-routers. `Commit` is already exported from `git.ts` (`{ sha, subject, date, author }`).

- [ ] **Step 1: Write failing tests** in `router.test.ts` (follow the harness that file already uses to build a caller over a temp vault). Cases:
  - **list**: seed a vault, commit a note twice → `history.list({ path })` returns ≥2 commits, newest-first (`[0].subject` is the latest).
  - **preview**: `history.preview({ path, sha: <older sha> })` returns `{ text }` equal to the older content.
  - **restore**: `history.restore({ remote, path, sha: <older sha> })` then re-read the file (`notes.read`) → equals the older content, **and** `history.list` has grown by one (a new commit landed).

- [ ] **Step 2: Run → FAIL** — `pnpm exec vitest run test/router.test.ts` (`history` undefined).

- [ ] **Step 3: Implement** the sub-router + registration.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/main/router.ts apps/desktop/test/router.test.ts
git commit -m "feat(history): history router — list/preview/restore over git log

Claude goes brr.. via Dash"
```

---

### Task 3: Rewrite `state/history.ts` — commit-based, path-keyed (clears the 6 baseline errors)

**Files:**
- Rewrite: `apps/desktop/src/renderer/src/state/history.ts`
- Rewrite: `apps/desktop/test/history-state.test.ts`

**Contract** — replace the whole module (it still calls the deleted `trpc.snapshots.*` and `DocMeta.id`, which *are* the 6 typecheck errors):
```ts
export interface Version { sha: string; subject: string; date: string; author: string }  // = git Commit

export const historyOpenAtom = atom(false)
export const versionsAtom = atom<Version[]>([])
export const selectedShaAtom = atom<string | null>(null)
export const previewAtom = atom<string | null>(null)
export const showAllVersionsAtom = atom(false)

// Pure, exported, tested directly (PRD §History "milestones fall out for free"):
// autosave commits are `Update …` (see commitMessage in active-vault); everything
// else — merges, reconciles, agent/seed commits — is a landmark worth surfacing.
export function partitionVersions(rows: Version[]): { landmarks: Version[]; automatic: Version[] }
  // automatic = rows.filter(v => /^Update /.test(v.subject)); landmarks = the rest.
export function versionLabel(v: Version): string   // v.subject.trim() || 'version'

export const loadVersionsAtom = atom(null, async (get, set) => { /* keyed on activeDocAtom.path → trpc.history.list */ })
export const loadPreviewAtom = atom(null, async (get, set, sha: string) => { /* trpc.history.preview; guard stale selection like the old code */ })
export const restoreVersionAtom = atom(null, async (get, set, sha: string) => {
  // flushAllBuffers() → trpc.history.restore.mutate({ remote: activeRemoteAtom, path: activeDocAtom.path, sha }) → set(loadVersionsAtom)
})
export const resetHistoryAtom = atom(null, (_get, set) => { /* clear versions/selection/preview/showAll */ })
```
**Gotchas:** key everything on `activeDocAtom.path` (no `.id` exists under D60 — that is the whole bug). Import `activeRemoteAtom` (and `flushAllBuffers` from `../lib/buffer-registry`) for restore. Keep the stale-preview guard from the old `loadPreviewAtom` (a note can close mid-flight). Do **not** re-sort — `history.list` is newest-first.

- [ ] **Step 1: Rewrite the tests** in `history-state.test.ts` to cover the pure reducers only (they currently test `partitionSnapshots`/`snapshotLabel`):
  - `partitionVersions` puts `{subject:'Update note.md'}` in `automatic` and `{subject:'Merge branch main'}` / `{subject:'reconcile: resolve conflicts'}` in `landmarks`.
  - `versionLabel` returns the subject; returns `'version'` for an empty subject.

- [ ] **Step 2: Run → FAIL** — `pnpm exec vitest run test/history-state.test.ts` (old reducer names gone).

- [ ] **Step 3: Implement** the module rewrite.

- [ ] **Step 4: Run → PASS**, then **typecheck**: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit 2>&1 | grep -c "error TS"` → **expect fewer than 6** (ideally 0; a residual error means `HistoryPanel.tsx` still references old names — that is Task 4).

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/state/history.ts apps/desktop/test/history-state.test.ts
git commit -m "refactor(history): commit-based, path-keyed state — retire the snapshots API

Claude goes brr.. via Dash"
```

---

### Task 4: Update `HistoryPanel.tsx` to the `Version` shape

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/HistoryPanel.tsx`

**Contract:** swap the imports/usages from the old `Snapshot` names to the new ones — `versionsAtom`, `selectedShaAtom`, `partitionVersions`, `versionLabel`, `loadVersionsAtom`, `loadPreviewAtom`, `restoreVersionAtom`; render `v.sha` as the key, `versionLabel(v)` as the row label, `when(v.date)` as the timestamp. Keep the landmarks/automatic fold (rename the fold's `automatic` copy to "older automatic saves"). Reword the restore `window.confirm`: it is a git commit everyone will pull, and it is itself revertible from this same timeline. Empty-state copy: "No versions yet — this file has no commits.".

- [ ] **Step 1: Implement** the field/label swaps. (No unit test — React panel, verified live in Task 5.)

- [ ] **Step 2: Typecheck** → **0** (`grep -c "error TS"`). This is the moment the baseline clears.

- [ ] **Step 3: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/components/HistoryPanel.tsx
git commit -m "refactor(history): HistoryPanel over the commit-based Version shape

Claude goes brr.. via Dash"
```

---

### Task 5: Mount the drawer + header History button (the affordance)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx`

**Contract:**
- **Mount:** render `<HistoryPanel />` right after `<AgentPanel />` (both are independent right drawers; if both open they stack — fine for v1).
- **Affordance (decided with Nicolai: a header button, not a shortcut, not a frontmatter click):** in the pane header strip (the `h-11` row that maps `pane.tabs`, ~`Shell.tsx:213`), add a right-aligned (`ml-auto`) icon button — lucide `History` — `title="version history"`, shown **only when the active tab is a note** (`tab?.kind === 'note'`). `onClick` toggles `historyOpenAtom` (`useSetAtom(historyOpenAtom)`, `set((v) => !v)`). Import `History` from `lucide-react` (mirrors the existing `Settings`/`SquareKanban` imports) and `historyOpenAtom` from `../state/history`.
- Leave ⌘J / `AgentPanel` untouched (agent widget is out of scope).

- [ ] **Step 1: Implement** the mount + button.

- [ ] **Step 2: Typecheck → 0.**

- [ ] **Step 3: Full suites green**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/packages/shared && pnpm exec vitest run           # 187
cd /Users/nicolaibthomsen/repos/syv/better-holi-final/apps/desktop && pnpm exec vitest run              # backgrounded; 666 + new
```

- [ ] **Step 4: Live check (renderer — hot-reloads, no relaunch).** Open a note edited a few times → click the header **History** clock → the drawer lists its commits (landmarks above, an "older automatic saves" fold below). Pick one → its content previews read-only. **Restore** → confirm → the note's content becomes that version and a new commit appears at the top of the list. Open a second note → the timeline swaps to that file's (per-doc). A brand-new unsaved note shows the empty state.

- [ ] **Step 5: Commit**
```bash
cd /Users/nicolaibthomsen/repos/syv/better-holi-final
git add apps/desktop/src/renderer/src/components/Shell.tsx
git commit -m "feat(history): mount the drawer + header button — version history is reachable

Claude goes brr.. via Dash"
```

---

## Self-review (coverage vs. `prd/vaults-sync.md` §History)

- **Version timeline from `git log --follow`, preview + restore** → Tasks 1–3 (`show`, the router, the state), surfaced in 4–5. ✓
- **Restore writes old content as a new commit, never a rewrite** → Task 2 `restore` (writeAtomic + `commitNow`). ✓
- **No custom snapshot store** → Task 3 deletes the last `trpc.snapshots.*`/`DocMeta.id` caller (and the 6 baseline errors with it). ✓
- **Milestones fold for free (surface non-autosave landmarks)** → Task 3 `partitionVersions` on the `Update ` prefix; Task 4 keeps the fold. ✓
- **Per-open-file** → state keyed on `activeDocAtom.path`; Task 5 button is note-only and the drawer resets per doc (existing `HistoryPanel` effect). ✓
- **Deferred (correctly):** the labeled `Restore … from <sha>` landmark commit; the agent floating widget; renamed-file preview before the rename — all called out in *Out of scope*.
