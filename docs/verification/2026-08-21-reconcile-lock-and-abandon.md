# Verified — the reconcile is a state, it locks what it is resolving, and it ends

**Date** 2026-08-21 · **Covers** `prd/vaults-sync.md` FR-18(d), FR-19, FR-20, and the `reconciling`
state FR-21 has always listed.

## What the tests prove, and why they are worth more than usual here

`test/active-vault.test.ts` runs against **real git** — a real bare repo as the remote, a second
clone as the teammate, no mocks of git or the filesystem. Every claim below is a passing test in
that file, which means it is a claim about what git and the working tree actually do, not about
what a fake was told to say.

1. **A live reconcile reports itself as `reconciling`, naming the files.** Previously it reported
   `paused — a merge is in progress`, which is true and useless: the paths the editor needs to lock
   were behind a generic pause.
2. **A merge nobody asked Holi for is still `paused`.** The distinction the whole state rests on.
   Mutation-checked: latching on `status.merging` instead of on who asked makes this test fail.
3. **The reconcile ends by itself when the agent commits the merge.** This was the bug underneath
   the requirement — nothing cleared the latch, so after the agent finished, the vault sat with
   autosave off, auto-pull off, and a conflict banner over a repo with nothing wrong with it, until
   the user clicked reconcile a second time. The test timed out on the old code, which is exactly
   what a user would have experienced.
4. **Autosave commits again afterwards** — the other half of "resumes normal operation".
5. **An agent *turn* ending does not end the reconcile.** Git coexistence lifts its pause after
   every turn and clears the sticky conflict pause on the way out; a reconcile runs through the
   agent and outlives its turns. Found by writing the test, not by reading the code.
6. **`abandon()` takes the merge back out of the tree and restores the banner** — markers gone,
   `merging` false, and the conflict still reported, because it is still a conflict.

`test/reconcile-lock.test.ts` covers what FR-19 locks: the files being resolved, nothing else in
the vault, and **nothing at all** for a conflict banner over a clean tree (FR-17 is non-blocking).
Both boundary tests were mutation-checked — widening the rule to any conflicted state kills them.

`editor/__tests__/read-only.test.tsx` asserts the lock the way a user would: a real editing command
refuses and the document does not change. Both stacks, because a conflicted `.holi/settings.json`
opens in the plain one.

## Checked by hand

The dev app was driven over CDP after the renderer changes: one pane, one editor, footer reading
`up to date`, no **Abandon** button, and `.cm-content` carrying `contenteditable="true"`. That
confirms no regression from `PaneView` reading the sync state, and confirms the attribute FR-19's
second half flips is real and observable in the actual browser — **jsdom does not implement
`contentEditable` at all**, so the dom test deliberately asserts the command's refusal instead.

## NOT checked

Say so plainly rather than implying more:

- **The lock, in the running app.** Producing a real reconcile in the dev app means pushing a
  conflicting change to a real GitHub vault, which is not something to do unasked. The state
  machine is covered against real git; what is unproven is the wiring from a pushed `reconciling`
  state through `PaneView` to a locked editor.
- **The caret disappearing.** `EditorView.editable.of(false)` is the half that stops a caret
  blinking in a document that silently swallows input. Its effect is a real-browser fact.
- **The Abandon button, clicked.** The procedure it calls is tested; the button is not.
- **A conflicted *task* file.** It renders in `TaskFileEditor`, not `EditorPane`, so FR-19's lock
  does not reach it. A task file full of conflict markers fails to parse and already renders in the
  broken strip, so the failure mode is visible rather than silent — but it is not locked.
- **Main was not restarted.** Main-process edits do not restart the electron-vite dev app, so the
  running instance still has the old router; only the renderer half was exercised live.
