# Agent Turn Review (D88) Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an agent turn ends, the footer says how many files changed, and a side panel shows each file's diff across the turn with per-hunk revert.

**Architecture:** A turn is a commit range. `agent-manager.setTurnActive` already brackets one and suspends sync for its duration, so recording `head()` at the start and the settle commit's sha at the end pins the range exactly. Nothing else is stored. The panel is `SidePanel` + the existing `DiffView` with `unifiedMergeView`'s `mergeControls` turned on; a revert writes through `writeAtomic` + `commitNow`, the same two calls `history.restore` makes.

**Tech Stack:** TypeScript, Electron main, tRPC, `@codemirror/merge`, Jotai, Vitest (`node` project for main, `dom` for renderer).

**Spec:** [`../specs/2026-09-02-agent-turn-review-design.md`](../specs/2026-09-02-agent-turn-review-design.md)

---

## What the spec settled, restated as constraints

- **Review after the turn, never a gate before the write.** No `PreToolUse` hook. Claude Code's own permission prompts already ask, and `vaults-sync.md` §Non-goals rules out an outbound gate.
- **The record is two shas.** `base` at turn start, `end` at the settle commit. No path list, no content, no queue.
- **Which files changed comes from the range, not from a tool hook.** A `PostToolUse` matcher would miss files the agent changed through `Bash`.
- **A revert is a new commit.** Never a history rewrite, matching `history.restore`.
- **A file open in an editor gets no special case.** `decideReload` already owns that.

## Decisions this plan locks (not in the spec)

- **The settle commit is taken explicitly, not observed.** On turn end, `setTurnActive(false)` resumes the vault and then awaits `commitNow()`, using its returned sha as `end`; `commitNow` returns `null` on a clean tree, in which case `end` falls back to `head()`. Waiting for the idle committer to fire on its own would make the end sha race a 3-second timer that the safety-cap path does not respect.
- **`setTurnActive` becomes async internally but keeps its void signature.** It is called from a hook-server request handler that must answer with an empty body immediately. The recording is fire-and-forget with a caught rejection: a failed turn record must never disturb the sync resume that shares this function.
- **The turn log is written by main, read by the renderer over tRPC.** The renderer never touches `.holi/turns.local.json`.
- **`DiffView` gains one optional prop rather than a sibling component.** `onResolve?: (text: string) => void`; when present the view is editable and `mergeControls` is on. `HistoryPanel` and `VaultHistory` keep passing neither and are untouched.
- **The chip reads `Claude changed N files`** and sits in the footer's left group beside the sync state. A config conflict still outranks it (`Shell.tsx:678`).

## File structure

| File | Responsibility |
|---|---|
| `main/git.ts` (modify) | `head()` and `rangeFiles(from, to)` on `GitRepo`. |
| `main/agent/turn-log.ts` (create) | `.holi/turns.local.json` — append a turn, read the list, cap at 50. Nothing else. |
| `main/agent/agent-manager.ts` (modify) | Records `base` on turn start and `end` on turn end, inside `setTurnActive`. |
| `main/router.ts` (modify) | A `turns` router: `list`, `files`, `fileDiff`, `revert`. |
| `renderer/state/turns.ts` (create) | Panel open state, the latest turn, its file list, the selected file's diff. |
| `renderer/composites/DiffView.tsx` (modify) | Optional `onResolve` turns on `mergeControls` and editability. |
| `renderer/features/agent/TurnReview.tsx` (create) | The side panel. |
| `renderer/components/Shell.tsx` (modify) | The footer chip, and mounting the panel beside `HistoryPanel`. |

Test commands:

```bash
pnpm -C apps/desktop exec vitest run --project node test/<file>.test.ts
pnpm -C apps/desktop exec vitest run --project dom src/renderer/**/<file>.test.tsx
pnpm -C apps/desktop test      # the full suite, before done
pnpm typecheck && pnpm lint
```

Bare `node` / `npx` do not work in this shell. Always `pnpm exec`, always from the repo root. Vitest suppresses `console.log`; write to a file if you need to see something.

---

### Task 1: `head()` and `rangeFiles()` on the repo

**Files:**
- Modify: `apps/desktop/src/main/git.ts` (the `GitRepo` interface ~145-183, and `openRepo`'s returned object)
- Test: `apps/desktop/test/git-range.test.ts` (create)

**Contract:**

```ts
export interface RangeFile {
  path: string
  added: number
  removed: number
  /** 'A' | 'M' | 'D' | 'R' — a rename reports its new path. */
  status: string
}

// on GitRepo:
/** The current commit, or null on an unborn branch (a vault with no commits). */
head(): Promise<string | null>
/** Paths changed across `from..to`, with line counts. Empty when the range is
 *  empty or either sha is unreachable — a dropped range is not an error. */
rangeFiles(from: string, to: string): Promise<RangeFile[]>
```

- [ ] **Step 1** Write `test/git-range.test.ts` against a real temp repo (follow the fixture style in the existing git tests): `head()` returns the sha after a commit and `null` on an unborn branch; `rangeFiles` reports an added file as `A` with `removed: 0`, a modified file's real counts, a deleted file as `D`, and returns `[]` for `sha..sha` and `[]` when a sha is unreachable.
- [ ] **Step 2** Run it and watch it fail on the missing methods.
- [ ] **Step 3** Implement. `head()` is `rev-parse HEAD` through `tryGit`, mapping a failure to `null` (an unborn branch makes `rev-parse` fail, and `RepoStatus.unborn` already exists for that state). `rangeFiles` needs two calls: `--numstat -z` and `--name-status -z` over `from..to`, joined on path. **Passing both flags to one `git diff` silently drops the counts** — the last flag wins and you get name-status output with no error, verified on 2026-09-02. Binary files report `-` for both counts in numstat; map those to `0`. Wrap both in `tryGit` and return `[]` on failure, per the contract.
- [ ] **Step 4** Run the test to green.
- [ ] **Step 5** Commit.

**Gotcha:** `-z` output is NUL-separated and `--name-status` emits rename entries as three fields (`R100`, old, new), not two. Parse defensively; a rename must yield one `RangeFile` at the new path.

---

### Task 2: The turn log

**Files:**
- Create: `apps/desktop/src/main/agent/turn-log.ts`
- Test: `apps/desktop/test/turn-log.test.ts`

**Contract:**

```ts
export interface TurnRecord {
  /** HEAD when the turn started. */
  base: string
  /** HEAD after the turn's settle commit. */
  end: string
  /** ISO timestamp of the turn's end. */
  at: string
}

export interface TurnLog {
  /** Newest first, capped. `[]` for a vault that has never run a turn, and for
   *  an unreadable or malformed file — a broken log must never break a turn. */
  list(): Promise<TurnRecord[]>
  /** Prepend and cap. A record whose base equals its end is dropped here, so
   *  callers never have to ask whether a turn changed anything. */
  append(record: TurnRecord): Promise<void>
}

export function openTurnLog(vaultRoot: string): TurnLog
```

- [ ] **Step 1** Write the test: an empty vault lists `[]`; an appended record comes back; a second append lands newest-first; 51 appends leave 50; a record with `base === end` is not stored; a file containing `not json` lists `[]` rather than throwing.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement over `.holi/turns.local.json`. Read-modify-write on each append; no in-memory cache, matching `calendar-prefs.ts`. Do not import Electron here — this file must load under plain Node like the rest of `agent/`.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

**Gotcha:** `.holi/` may not exist in a freshly cloned vault. `mkdir` with `recursive: true` before the first write, the way `excludeLocally` does for `.git/info`.

---

### Task 3: Record the range around the turn bracket

**Files:**
- Modify: `apps/desktop/src/main/agent/agent-manager.ts` (`setTurnActive`, ~line 224)
- Modify: `apps/desktop/src/main/index.ts` (inject the dep)
- Test: `apps/desktop/test/agent-turn-record.test.ts`

**Contract:** `AgentManagerDeps` gains

```ts
/** Records a turn's commit range. Absent in tests that do not care. */
turnLogFor?: (remote: string) => TurnLog
```

Order inside `setTurnActive`:

- **`active === true`** — capture `base` **before** `pause()`. It is the same sha either way today, but the ordering states the intent: the base is the tree the turn started against.
- **`active === false`** — `clearSafety()`, `resume()`, then `void recordTurnEnd()`, then `pushStatus()`. `recordTurnEnd` awaits `commitNow()` and falls back to `head()` when it returns `null`, then appends. Every rejection inside it is caught and logged.

- [ ] **Step 1** Write the test with a fake `VaultHost` and a fake `TurnLog`: a start-then-end pair appends one record whose `base` is the pre-turn head and whose `end` is the settle commit's sha; a turn that commits nothing (`commitNow` → `null`) records `end` as `head()`; the safety-cap path (`turnSafetyMs` elapsed, no `Stop`) records the same way; a `commitNow` that throws still resumes the vault and appends nothing.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement. Keep `setTurnActive`'s signature `void`.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

**Gotcha:** `setTurnActive` returns early when `session === null`, so a stray hook cannot record a turn for a vault with no agent. Preserve that guard ahead of any recording.

**Gotcha:** `resume()` must happen before the commit, not after. `commitAll` refuses to run while the vault reads as paused, and a turn that never resumed the vault is the failure mode the safety cap exists to prevent.

---

### Task 4: The `turns` tRPC router

**Files:**
- Modify: `apps/desktop/src/main/router.ts` (beside the `history` router, ~1365, and the router assembly at ~2085)
- Test: `apps/desktop/test/router-turns.test.ts`

**Contract:**

```ts
turns: {
  /** The vault's turn records, newest first. */
  list: query() => Promise<TurnRecord[]>
  /** Files changed across one turn. */
  files: query({ base: string; end: string }) => Promise<RangeFile[]>
  /** One file's before/after across the turn, for the merge view. Either side is
   *  `''` when the file was added or deleted. */
  fileDiff: query({ base: string; end: string; path: string })
    => Promise<{ before: string; after: string }>
  /** Write the resolved text and commit it. A new commit, never a rewrite. */
  revert: vaultMutation({ remote: string; path: string; text: string })
    => Promise<{ ok: true }>
}
```

- [ ] **Step 1** Write the test: `files` passes through to `repo.rangeFiles`; `fileDiff` returns `''` for a side whose `show` rejects (mirroring `history.fileDiff`); `revert` calls `writeAtomic` then `commitNow`; `revert` on a path outside the vault is refused by `safe()`.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement. Copy `history.fileDiff`'s `.catch(() => '')` shape verbatim and `history.restore`'s `writeAtomic` + `commitNow` pair verbatim. Use `safe(input.path)` on every path.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

---

### Task 5: `DiffView` gains merge controls

**Files:**
- Modify: `apps/desktop/src/renderer/src/composites/DiffView.tsx`
- Test: `apps/desktop/src/renderer/src/composites/__tests__/DiffView.test.tsx`

**Contract:**

```ts
export function DiffView({ before, after, onResolve }: {
  before: string
  after: string
  /** Present: the view is editable, per-hunk accept/reject controls are on, and
   *  this fires with the document text after each resolution. Absent: read-only,
   *  exactly as the history panel has always had it. */
  onResolve?: (text: string) => void
}): React.JSX.Element
```

- [ ] **Step 1** Write the test: with no `onResolve` the view is not editable and renders no merge controls; with `onResolve` the controls render; rejecting a chunk fires `onResolve` with text equal to `before` for a single-chunk diff.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement: `mergeControls: !!onResolve`, drop `EditorState.readOnly` / `EditorView.editable` to `!onResolve`, and add an `updateListener` that fires `onResolve(view.state.doc.toString())` on `docChanged`.
- [ ] **Step 4** Green, and re-run the history tests to confirm the read-only call sites did not move.
- [ ] **Step 5** Commit.

**Gotcha:** the effect currently rebuilds the whole `EditorView` on any prop change, and `onResolve` will be a fresh closure per render. Keep it in a ref and leave it out of the dependency array, or every keystroke-driven re-render destroys and rebuilds the merge view mid-resolution.

---

### Task 6: Renderer state

**Files:**
- Create: `apps/desktop/src/renderer/src/state/turns.ts`
- Test: `apps/desktop/src/renderer/src/state/__tests__/turns.test.ts`

**Contract:** `turnReviewOpenAtom`, `latestTurnAtom` (`TurnRecord | null`), `turnFilesAtom` (`RangeFile[]`), `selectedTurnPathAtom`, `turnDiffAtom`, and the loaders `loadLatestTurnAtom`, `loadTurnFilesAtom`, `loadTurnDiffAtom`, `revertFileAtom`, `resetTurnReviewAtom`. Follow `state/history.ts` exactly — same naming, same loader-atom shape.

- [ ] **Step 1** Write the test: `loadLatestTurnAtom` sets `latestTurnAtom` from the first record and leaves it `null` for an empty list; switching vault resets; `revertFileAtom` calls the mutation and reloads the file list.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

**Gotcha:** the turn list must reload when a turn ends. `agent:status` already pushes on every `setTurnActive`, so subscribe to `working` going `true → false` rather than polling.

---

### Task 7: The review panel

**Files:**
- Create: `apps/desktop/src/renderer/src/features/agent/TurnReview.tsx`
- Test: `apps/desktop/src/renderer/src/features/agent/__tests__/TurnReview.test.tsx`

**Shape:** `SidePanel` + `PanelHeader`, mirroring `HistoryPanel`. Header names the turn and its time. Body is the file list from `turnFilesAtom`, each row showing the path and `+N / −M`; the selected row expands to `DiffView` with `onResolve` wired to `revertFileAtom`. Empty range renders nothing, because the chip that opens it never appears for one.

- [ ] **Step 1** Write the test: a two-file turn renders two rows with their counts; clicking a row loads and shows its diff; resolving fires the revert mutation with the resolved text; a turn whose shas are unreachable renders the "this turn's history is gone" sentence rather than an error.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement. Reuse `HistoryPanel`'s busy/error `guard` wrapper rather than writing a second one. No em dashes in the copy.
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

---

### Task 8: The footer chip

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Shell.tsx` (the footer, ~763-811; mount the panel beside `HistoryPanel`, ~649)
- Test: `apps/desktop/src/renderer/src/components/__tests__/Shell.test.tsx` (extend)

- [ ] **Step 1** Write the test: with a non-empty latest turn the footer shows `Claude changed 4 files`; clicking it opens the panel; an empty turn shows no chip; a config conflict still outranks it in that region.
- [ ] **Step 2** Run it, watch it fail.
- [ ] **Step 3** Implement. Singular and plural both read correctly (`1 file`).
- [ ] **Step 4** Green.
- [ ] **Step 5** Commit.

---

### Task 9: Verify in the running app

- [ ] **Step 1** `pnpm dev:debug`. Main-process edits do not hot reload, so this must be a fresh start.
- [ ] **Step 2** Open a vault, ask the agent to change two notes, let the turn end.
- [ ] **Step 3** Confirm the chip appears with the right count, the panel lists both files with their counts, and each diff is the turn's change and not the whole file.
- [ ] **Step 4** Reject a hunk in a file that is **closed**. Confirm a new commit lands and the file on disk has the hunk reverted.
- [ ] **Step 5** Reject a hunk in a file that is **open with a dirty buffer**. Confirm `decideReload` merges rather than clobbering, which is the case this design leans on hardest.
- [ ] **Step 6** Interrupt a turn with Ctrl-C so `Stop` never fires, wait out `turnSafetyMs` (override it low for the test), and confirm the turn is still recorded.
- [ ] **Step 7** Screenshot the panel via `pnpm exec node apps/desktop/cdp.mjs --shot`.

---

### Task 10: Documentation

- [ ] **Step 1** Add the **D88** row to `docs/decisions.md`, following the surrounding format.
- [ ] **Step 2** Fold the feature into [`docs/prd/agent.md`](../prd/agent.md) as a section describing what now exists, beside §Git coexistence, which owns the turn bracket this rides on.
- [ ] **Step 3** Note in [`docs/prd/notes-editor.md`](../prd/notes-editor.md) §External writes that a revert is an ordinary external write and takes the same path.
- [ ] **Step 4** Add the verified entry to `docs/upcoming.md`.
- [ ] **Step 5** Commit.

---

## Gates before done

```bash
pnpm -C apps/desktop test    # the FULL desktop suite, not just touched files
pnpm typecheck
pnpm lint                    # 0 errors; 4 pre-existing warnings
```

The suite stood at 178 files / 2380 tests green before this plan.
