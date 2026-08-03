# Undo across an external reload — design

**Date:** 2026-08-03
**Resolves:** `docs/prd/notes-editor.md` Open question 3 (§Undo, §External writes, §Edge cases).
**Status:** approved, ready for planning.

## Problem

When a file changes underneath an open editor, `decideReload(base, buffer, disk)` returns one
of four variants and `EditorPane` acts on it (`EditorPane.tsx:249-272`). The two variants that
replace buffer text do so with a whole-document dispatch:

```ts
view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: decision.text } })
```

This has two defects:

1. **Undo reaches foreign / stale text.** The replace lands in CodeMirror's `history` like any
   edit. For a clean `reload` (an agent rewrites a file you have open but haven't touched), ⌘Z
   reverts to the now-stale pre-rewrite text; because `base` is already the new disk text, the
   next autosave writes that stale text *back*, clobbering the rewrite. For a `merged` reload,
   ⌘Z would revert the whole merge rather than unwinding your own keystrokes.
2. **The caret jumps.** A full-document `from:0 .. to:len` replace collapses the selection to the
   end of the document, so a `merged` reload that lands while you are typing yanks the caret to
   the bottom.

The four variants:

| variant | when | dispatched? |
|---|---|---|
| `none` | `disk === base` (includes the editor's own save) | no |
| `reload` | clean buffer, disk changed | yes |
| `merged` | dirty buffer, non-overlapping foreign edit, merge3 succeeded | yes |
| `conflict` | dirty buffer, overlapping edit | no — routed to `onConflict` (reconcile) |

## Decision

**A foreign reload is a co-author's edit, not your undo step.** `notes-editor.md` §Undo (line 151)
states the whole purpose of the retired `Y.UndoManager` was that "undo unwound *your* edits and
not a co-author's." A non-overlapping foreign merge is exactly a co-author's edit, so:

- The reload dispatch is annotated **`Transaction.addToHistory.of(false)`** — it is never a
  discrete undo step. CodeMirror still remaps the stored history through the change, so ⌘Z
  continues to unwind *your* keystrokes at the correct positions, and the foreign text stays.
- This applies to **both** dispatched variants (`reload` and `merged`); `conflict` and `none`
  are unchanged.

This is a deliberate reversal of the PRD's tentatively-worded leaning ("the merge is a single
undoable transaction, so ⌘Z reverts to your text and re-flags the conflict"). That leaning
contradicts §Undo line 151, and "re-flags the conflict" does not apply to a `merged` result —
merge3 *succeeded*; there was never a conflict flag to re-raise. The `conflict` variant, which
does raise one, never reaches this dispatch.

## Caret preservation via minimal diff

Rather than replace the whole document, dispatch only the bytes that changed, computed as a
common-prefix / common-suffix diff. Caret preservation then falls out of CodeMirror's automatic
selection mapping — no manual offset arithmetic.

For a `merged` reload the diff of `buffer` against `merged` is **exactly the foreign edit**
(your own edits are already present in both texts), so the changed span sits in a region your
caret is not in, and the caret rides along untouched.

Worked example: base `A\nB`; you append → buffer `A\nB\nyours`; agent prepends → disk
`top\nA\nB`; merged `top\nA\nB\nyours`. `minimalChange(buffer, merged)` = insert `top\n` at
offset 0. CodeMirror maps your caret in `yours` forward by 4 — still in `yours`.

The dispatch also omits `scrollIntoView`, so a background reload does not move the viewport.

## Components

### `minimalChange(current, target)` — pure

Lives beside `decideReload` in `apps/desktop/src/renderer/src/lib/editor-reload.ts`.

```ts
export function minimalChange(
  current: string,
  target: string,
): { from: number; to: number; insert: string } | null
```

- Framework-free: returns a plain object (CodeMirror `ChangeSpec` shape) or `null` when the texts
  are identical. No CodeMirror import.
- Algorithm: longest common prefix + longest common suffix (non-overlapping), replace the middle.
  - `from` = prefix length.
  - `to` = `current.length − suffixLength`.
  - `insert` = `target.slice(prefixLen, target.length − suffixLen)`.
  - Clamp so prefix and suffix do not overlap when one string is a substring of the other.

A single-span diff is coarser than a multi-hunk diff when the foreign change is non-contiguous,
but it is always correct (one contiguous replacement still yields the target text); caret
preservation only degrades if the caret sits inside that one span, which does not occur for the
`merged` case.

### `applyReload(view, text)` — view effect

New module `apps/desktop/src/renderer/src/lib/apply-reload.ts`.

```ts
export function applyReload(view: EditorView, text: string): void
```

- Computes `minimalChange(view.state.doc.toString(), text)`; returns early if `null`.
- Dispatches that single change with `annotations: [Transaction.addToHistory.of(false)]` and no
  `scrollIntoView`.
- Does **not** touch `baseRef` or write to disk — those stay in `EditorPane`, which owns the
  effectful trpc calls.

### `EditorPane` wiring

The `EditorPane.tsx:261-267` block becomes:

```ts
baseRef.current = decision.text
applyReload(view, decision.text)
if (decision.kind === 'merged') {
  void trpc.notes.write.mutate({ remote, path, text: decision.text })
}
```

`base` still advances before the dispatch; the `merged` write-back is unchanged. `conflict`
(short-circuits to `onConflict`) and `none` (returns) are untouched.

## Testing

- **node** — extend `apps/desktop/test/editor-reload.test.ts` for `minimalChange`: identical →
  `null`; pure insert; pure delete; middle replace; prefix+suffix overlap (one string a substring
  of the other); empty-string edges.
- **dom** — new `apps/desktop/src/renderer/src/lib/apply-reload.test.tsx` against a real
  `EditorView` with `history()`:
  - caret offset is preserved through a foreign insert placed before it;
  - `undo` (from `@codemirror/commands`) unwinds the user's own edit while the foreign text
    remains;
  - the reload dispatch is not itself a discrete undo step (one `undo` after a user edit +
    reload lands on the pre-user-edit text, not on the pre-reload text).

## Non-goals / known minor

- **Clean-reload history.** After a clean `reload` of an unrelated rewrite, `addToHistory:false`
  leaves your pre-reload history remapped onto the new content, so ⌘Z there can behave oddly. It
  can no longer revert-to-stale-and-clobber (the actual bug), which is the fix that matters.
  Clearing history on a clean reload is possible but more machinery and is deliberately out of
  scope.
- **Multi-hunk diff.** Not needed (see `minimalChange` note above); a single-span diff is correct
  and sufficient for caret preservation in the `merged` case.
- The echo-loop guard (§Save line 150) is undisturbed: `applyReload` changes only *how* the
  reload text is dispatched, not the content-comparison attribution in `decideReload`.

## Seams (reference)

- `apps/desktop/src/renderer/src/lib/editor-reload.ts` — `decideReload` (pure), + `minimalChange`.
- `apps/desktop/src/renderer/src/lib/apply-reload.ts` — new, `applyReload`.
- `apps/desktop/src/renderer/src/composites/EditorPane.tsx:249-272` — the reload effect.
- `apps/desktop/test/editor-reload.test.ts` — node tests.
