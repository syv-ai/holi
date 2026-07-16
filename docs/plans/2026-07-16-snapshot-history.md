# Snapshot history — the safety net you can finally reach

> **For agentic workers:** use the executing-plans skill. Steps are checkboxes. This plan is **lean by design** — it states contracts, decisions and gotchas. Derive the code.

**Goal:** open a note, see its versions, read one, put it back. `agent.md` sells "before Claude edited" as the thing that makes letting an agent loose in your notes safe — today that snapshot is taken faithfully on every agent write and **no human can see it**.

**The state of play:** `snapshots.list/take/restore` are all built and tested (`apps/server/test/snapshots.test.ts`). Snapshots accumulate for real: every 10 min (`maybeIntervalSnapshot`, `hooks.ts:65`, `reason:'interval'`, **`label: null`**), before every agent write (`reason:'pre-agent-write'`, `label:'before Claude edited'`), before every link-rewriting rename (`rename.ts:61`, `` label:`before [[a]] → [[b]]` ``), and before every restore (`reason:'pre-restore'`). The **only** client caller is main taking one (`mirror-api.ts:13`). `list` and `restore` have **zero callers anywhere**. Restore is already non-destructive — `replaceAllText` inside one `ydoc.transact` through the live room, with the pre-restore snapshot as the undo — so this slice is a reading surface over finished machinery, plus the one procedure that machinery is missing.

**Spec:** `prd/vaults-collaboration.md` §History ("browse the timeline and restore") · `prd/agent.md` (the "before Claude edited" promise).

---

## Decisions

| # | Decision |
|---|---|
| **D53** | **`snapshots.preview` ships with the timeline — a blind restore is not a feature.** `list` deliberately does **not** select `state` (`snapshots.ts:15`), and there is no `get`/`preview`, so **nothing in the current router can tell you what is in a version.** A timeline built on it alone offers "restore 10:31" versus "restore 09:58" and no way to tell them apart — for `reason:'interval'` rows, which carry **`label: null`**, the *only* distinguishing information on screen is a timestamp. Picking by timestamp is guessing, and the fact that guessing is recoverable (the pre-restore snapshot) is not a reason to make the user do it. **Why it is cheap:** `docText(docFromState(snap.state))` is the exact pair `restore` already runs (`snapshots.ts:53`) before it writes; preview is restore with the write removed. **Read-only, and it does not mount an editor** — a version is prose to read, not a second surface to maintain. Agreed with Nicolai 2026-07-16. |
| **D54** | **Retention stays an open question. The timeline folds automatic snapshots; it deletes nothing.** `prd/vaults-collaboration.md` flags pruning as open and warns against inventing a policy — this slice does not. **The problem is real regardless:** a doc touched all day mints an interval snapshot every 10 min, so a visible timeline is mostly unlabelled rows within a week, and the `pre-agent-write` snapshot the whole feature exists to surface is buried among them. **The fix is display, not deletion:** rows split on `reason === 'interval'` — *milestones* (someone or something did a thing: an agent wrote, a rename rewrote links, a restore ran) render in the timeline; *automatic* rows fold behind a "show all versions" toggle. **Why not prune:** pruning is data loss, it needs its own D#-decision, and the thing forcing the question is a rendering problem that a rendering fix answers completely. **Why not show everything flat:** honest but useless — it buries the milestone rows in noise, which is the same failure as having no UI. Nothing about this closes the retention question; `yjs_snapshots` holds a full `Y.Doc` state per row and still grows unbounded, and that is still worth answering, later, on purpose. Agreed with Nicolai 2026-07-16. |

## Contract

**Server (`apps/server/src/routers/snapshots.ts`):**
- `preview`: `authedProcedure`, input `{ docId: uuid, snapshotId: uuid }` → `{ text: string }`. Mirror `restore`'s shape exactly — `requireDocAccess(ctx.db, docId, ctx.user.id)`, then **verify the snapshot belongs to the doc** and `NOT_FOUND` if not (`restore` does this; a preview that reads any snapshot by id is a cross-doc read past the doc gate). Body is `docText(docFromState(snap.state))`.
- **Do not touch `list`, `take` or `restore`.** They are correct and tested. In particular `take` hardcodes `reason:'pre-agent-write'` / `label:'before Claude edited'` — that is fine because its only caller *is* the agent path, and it is **not** a general "save a version" endpoint. This slice adds no manual-snapshot button, so nothing needs it to become one.

**Desktop — state (`state/history.ts`, new):**
- `historyOpenAtom`, `snapshotsAtom`, `selectedSnapshotIdAtom`, `previewAtom`, `showAllVersionsAtom`; write-atoms `loadSnapshotsAtom`, `loadPreviewAtom`, `restoreSnapshotAtom`. Follow `state/members.ts` — plain `trpc.x.y.query()/.mutate()` inside jotai write-atoms; there is no React Query and no `trpc.useQuery` hook in this codebase.
- All three procedures key off `activeDocAtom`. History is **per-doc**: opening a different note reloads the list and clears the selection and preview.
- `restoreSnapshotAtom` → `restore` → **refetch the list** (the restore just minted a `pre-restore` row, and a timeline missing the undo of the thing you just did is the one moment it matters most). **No doc refetch:** `replaceAllText` goes through the live room, so the open editor updates itself over CRDT.

**Desktop — the pure half (tested headless):**
- `partitionSnapshots(rows) → { milestones, automatic }`, split on `reason === 'interval'` (D54). Put it beside the atoms under a `// --- reducers` banner, as `state/tasks.ts:42` does.
- `snapshotLabel(row) → string` — the display string. `label` when present; otherwise derive from `reason`; otherwise a last-resort fallback. **Every current writer sets a label except `interval`**, so in practice this is "label, or 'automatic version'" — but `label` and `reason` are both nullable columns and the function must not render `null` at a user.

**Desktop — UI (`components/HistoryPanel.tsx`, new):**
- A **right-hand drawer beside the editor**, mirroring `AgentPanel`'s shape and its `agentPanelOpenAtom` idiom (`Shell.tsx:207`). Not a third `viewAtom` entry (history is *about the open note*, not a peer surface to notes/board) and not a modal (**no modal, dialog, `<dialog>` or `role="dialog"` primitive exists in this codebase** — inventing one here is a different slice).
- Toggle from the header row that already names the open note (`Shell.tsx:190-201`). Render only when `view === 'notes'` and `activeDoc` is set.
- Timeline (milestones, `takenAt DESC` — `list` already orders it) → select a row → preview loads → `[ Restore this version ]`. A `⌄ N automatic versions` disclosure reveals the folded rows, which select and preview identically (D54 is display-only; an automatic version is restorable like any other).
- Restore **confirms first** — `window.confirm`, matching `MembersSection.tsx:65`, the codebase's only destructive-confirm precedent. Say what it does: it replaces the note's text and can itself be undone.
- `VaultSettings`'s `guard()` busy/error wrapper is the house pattern for "call the server from a panel" — reuse it, do not invent a second.

## Tasks

- [x] **1** → `1f7fe0e`. **Finding: the cross-doc test needed a positive control** — tRPC's caller proxy rejects an *unknown procedure* with `NOT_FOUND` too, so it passed before `preview` existed. `snapshots.preview` + test in `apps/server/test/snapshots.test.ts`. TDD. Cover: text round-trips a known seeded snapshot; a snapshot id from a **different doc** is `NOT_FOUND` (the cross-doc gate — it is the only security-relevant line in the procedure); a non-member is `FORBIDDEN`. `test/rename.test.ts` is the template for a ctx with `getLiveDoc` + seeded CRDT text. Commit alone.
- [x] **2** → `4fa4b4a`. `state/history.ts` + `partitionSnapshots`/`snapshotLabel`, TDD headless (`test/board-state.test.ts` is the model — node env, no jotai store, test names that state the invariant). Pin: interval rows fold; a `pre-agent-write` row never folds; a row with `label: null` **and** `reason: null` still renders a string.
- [x] **3** → `4fa4b4a`. `HistoryPanel.tsx` + the header toggle + Shell wiring.
- [x] **4** VERIFIED LIVE (probe deleted): opened a note, took a `pre-agent-write` snapshot as the bridge does, and **"before Claude edited" appeared in the timeline for the first time**; selecting it previewed the text read-only; restore ran through the real button and left `before restoring an older version` behind (server reasons: `["pre-restore","pre-agent-write"]`) — the round trip proves it is non-destructive. The interval fold rendered (`⌄ 1 automatic version`) on a note with a real 10-min-old snapshot. **Probe gotchas: `a ?? b || c` is a SyntaxError** (every CDP evaluate threw and `waitFor` swallowed it into a timeout), and **jotai state survives between probe runs** — `location.reload()` first, then assert the header names the note you meant to open. `pnpm -r test` + `pnpm -r typecheck` + desktop build. Then the **real app** (recipe: handoff §Running the app):
  1. Open a note, have Claude edit it, open history → **"before Claude edited" is there and readable**. That is the slice — it is the first time that snapshot has ever been visible.
  2. Restore it → **the open editor updates live** (no refetch, no reload) → history now shows "before restoring an older version" → restore *that* → you are back. The round trip is the proof that restore is non-destructive.
  3. Leave a doc open past the 10-min interval → an automatic version appears **folded**, and expands.
- [x] **5** `prd/vaults-collaboration.md` §History: the timeline ships; **restate retention as still open** and say why the fold is not an answer to it. `prd/agent.md`: the "before Claude edited" net is now reachable. Record D53/D54 in `docs/decisions.md` (**D53** if the stream plan landed first — check, the numbering is shared). **Never `git add` anything under `docs/`.**

## Gotchas

- **`takenAt` is a `Date` on the server and an ISO string in the renderer.** There is **no superjson transformer** on the ipcLink (`lib/trpc.ts`). Sorting or formatting it as a `Date` without parsing will not throw — it will quietly do the wrong thing. `list` already sorts server-side; do not re-sort client-side and you sidestep most of it.
- **`state` is a full `Y.Doc` per row, and `list` never selects it.** Keep it that way — a timeline that ships every version's bytes to render a list of labels is a footgun that grows with the doc.
- **Restore's snapshot ordering has a real gap — do not "fix" it here.** `restore` writes the edit and takes the `pre-restore` snapshot **after** (`snapshots.ts:53`), with no transaction spanning both, so a throw between them leaves the edit committed with no undo. Content is correct; the window is small; widening this slice into transactional snapshot semantics is how it stops shipping. **Log it as an open question** and move on.
- **Four `SnapshotReason` values have no writer** — `'manual'`, `'pre-offline-merge'`, `'pre-reconcile'`, `'pre-git-ingest'`. They are aspirational, not a contract. `snapshotLabel` must not assume a reason it has never seen is impossible, and you must not add a manual-snapshot button just because `'manual'` is sitting there (YAGNI — the PRD asks to browse and restore, not to save).
- **`restore` has no role gate.** It is `authedProcedure` + `requireDocAccess`, so **any member — including `member` role — can restore any doc**. That is the existing rule for every note mutation in this codebase (`notes.rename`/`delete` are the same), so it is consistent, not an oversight. Don't quietly tighten it in a UI slice; if it should be owner-only, that is a decision, not a detail.
- **A restore is a CRDT edit, not a rewind.** It produces *new* state, and every connected client sees it live — including a teammate mid-sentence in that note. The confirm text should not imply a private undo.
- **Interval snapshots only fire via `onStoreDocument`** — the relay's store is **debounced 2000ms**. When verifying live, wait it out before asserting a snapshot exists.
