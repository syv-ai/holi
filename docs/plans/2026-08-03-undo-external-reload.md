# Undo across an external reload — Implementation Plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a file changes underneath the editor, dispatch the reload as a minimal diff annotated `addToHistory:false`, so ⌘Z unwinds *your* edits (never the foreign text or stale content) and the caret rides through unmoved.

**Architecture:** One pure helper (`minimalChange`, prefix/suffix diff) beside `decideReload`; one thin view-effect (`applyReload`) that dispatches that diff with `Transaction.addToHistory.of(false)` and no scroll; a three-line swap in `EditorPane`'s reload effect. `base` advancement and the `merged` disk write-back stay in `EditorPane`.

**Tech Stack:** TypeScript, CodeMirror 6 (`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`), Vitest 4 (node + jsdom projects).

**Spec:** `docs/specs/2026-08-03-undo-external-reload-design.md`

**Working directory for all commands:** `apps/desktop`. (Bash cwd drifts to repo root after any `git commit` that uses `cd`; re-`cd apps/desktop` before each `pnpm exec vitest` or it resolves the wrong config.)

---

### Task 1: `minimalChange` — pure prefix/suffix diff

Computes the single contiguous change that turns `current` into `target`. Lives beside `decideReload`; framework-free (plain object, no CodeMirror import). Tested in the **node** project (`test/**/*.test.ts`).

**Files:**
- Modify: `apps/desktop/src/renderer/src/lib/editor-reload.ts` (append `minimalChange`)
- Test: `apps/desktop/test/editor-reload.test.ts` (append a `describe` block)

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/editor-reload.test.ts` (add `minimalChange` to the existing import on line 16 → `import { decideReload, minimalChange } from '../src/renderer/src/lib/editor-reload'`):

```ts
describe('minimalChange', () => {
  it('returns null when the texts are identical', () => {
    expect(minimalChange('hello\n', 'hello\n')).toBeNull()
  })

  it('reports a pure insertion as an empty-range change', () => {
    // Foreign edit prepended; nothing of `current` is removed.
    expect(minimalChange('hello', 'TOP\nhello')).toEqual({ from: 0, to: 0, insert: 'TOP\n' })
  })

  it('reports a pure deletion as an empty insert', () => {
    expect(minimalChange('one\ntwo\nthree', 'one\nthree')).toEqual({
      from: 4,
      to: 8,
      insert: '',
    })
  })

  it('reports a middle replacement bounded by the common prefix and suffix', () => {
    // "one\n" prefix, "\nthree" suffix, only "two" -> "TWO" between them.
    expect(minimalChange('one\ntwo\nthree', 'one\nTWO\nthree')).toEqual({
      from: 4,
      to: 7,
      insert: 'TWO',
    })
  })

  it('clamps so the prefix and suffix cannot overlap when one text contains the other', () => {
    // Common prefix "aa" (len 2) and common suffix "aa" (len 2) would sum past
    // current.length (3); the suffix is clamped to a single deletion at the end.
    expect(minimalChange('aaa', 'aa')).toEqual({ from: 2, to: 3, insert: '' })
  })

  it('handles the empty-string edges', () => {
    expect(minimalChange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' })
    expect(minimalChange('gone', '')).toEqual({ from: 0, to: 4, insert: '' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/desktop && pnpm exec vitest run --project node test/editor-reload.test.ts`
Expected: the `minimalChange` block FAILS — `minimalChange is not a function` (the existing `decideReload` tests still pass).

- [ ] **Step 3: Write the minimal implementation**

Append to `apps/desktop/src/renderer/src/lib/editor-reload.ts` (after `decideReload`):

```ts
/**
 * The single contiguous change that turns `current` into `target`: the span
 * between their common prefix and common suffix. `null` when they are equal.
 *
 * A one-span diff is coarser than a multi-hunk one, but it is always correct —
 * and for a `merged` reload the diff of the buffer against the merged text *is*
 * the foreign edit, so the changed span never covers the caret, and CodeMirror's
 * selection mapping preserves it for free. Framework-free on purpose: the return
 * is a CodeMirror `ChangeSpec` shape, but this module holds no view dependency.
 */
export function minimalChange(
  current: string,
  target: string,
): { from: number; to: number; insert: string } | null {
  if (current === target) return null
  const maxPrefix = Math.min(current.length, target.length)
  let prefix = 0
  while (prefix < maxPrefix && current[prefix] === target[prefix]) prefix++
  // Cap the suffix so it cannot reach back past the prefix in either string —
  // otherwise "aaa" -> "aa" would double-count the shared run.
  const maxSuffix = Math.min(current.length - prefix, target.length - prefix)
  let suffix = 0
  while (
    suffix < maxSuffix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    from: prefix,
    to: current.length - suffix,
    insert: target.slice(prefix, target.length - suffix),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/desktop && pnpm exec vitest run --project node test/editor-reload.test.ts`
Expected: PASS (all `decideReload` and `minimalChange` tests green).

- [ ] **Step 5: Commit**

```bash
cd apps/desktop && git add src/renderer/src/lib/editor-reload.ts test/editor-reload.test.ts && git commit -m "feat(editor): minimalChange prefix/suffix diff for reloads

Claude goes brr.. via Dash"
```

---

### Task 2: `applyReload` — dispatch the reload out of history, caret intact

Thin view-effect: minimal diff dispatched with `addToHistory:false` and no scroll. Tested in the **dom** project against a real `EditorView`. The dom project globs `src/renderer/**/*.test.tsx`, so the test file MUST end in `.test.tsx` even though it holds no JSX.

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/apply-reload.ts`
- Test: `apps/desktop/src/renderer/src/lib/apply-reload.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/lib/apply-reload.test.tsx`:

```tsx
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { applyReload } from './apply-reload'

let view: EditorView

beforeEach(() => {
  view = new EditorView({
    state: EditorState.create({ doc: 'hello', extensions: [history()] }),
    parent: document.body,
  })
})

afterEach(() => view.destroy())

function userType(at: number, insert: string): void {
  // A normal edit: goes into history (addToHistory defaults to true).
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } })
}

test('a foreign insertion before the caret keeps the caret on the same character', () => {
  userType(5, '!') // "hello!" caret at 6
  applyReload(view, 'TOP\nhello!') // foreign prepend of 4 chars
  expect(view.state.doc.toString()).toBe('TOP\nhello!')
  // Caret was at 6, the insert added 4 chars before it -> 10, still just after '!'.
  expect(view.state.selection.main.head).toBe(10)
})

test('undo unwinds your edit and leaves the foreign text; the reload is not an undo step', () => {
  userType(5, '!') // your edit, in history
  applyReload(view, 'TOP\nhello!') // foreign edit, NOT in history
  undo(view)
  // One undo removed your '!' and skipped the reload entirely: the foreign
  // "TOP\n" survives, proving the reload never became a discrete undo step.
  expect(view.state.doc.toString()).toBe('TOP\nhello')
})

test('an identical reload is a no-op', () => {
  applyReload(view, 'hello')
  expect(view.state.doc.toString()).toBe('hello')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/desktop && pnpm exec vitest run --project dom src/renderer/src/lib/apply-reload.test.tsx`
Expected: FAIL — cannot resolve `./apply-reload` / `applyReload is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/desktop/src/renderer/src/lib/apply-reload.ts`:

```ts
/**
 * Apply a reload's text to the live buffer as a *co-author's* edit, not your own.
 *
 * Two things make this not-your-edit: the change is dispatched with
 * `addToHistory:false`, so ⌘Z never lands on foreign or stale text (CodeMirror
 * still remaps your own history through it, so your keystrokes stay undoable at
 * the right positions); and it is a `minimalChange` diff rather than a
 * whole-document replace, so CodeMirror's selection mapping carries the caret
 * through untouched. No `scrollIntoView`: a background reload must not move the
 * viewport. See `docs/specs/2026-08-03-undo-external-reload-design.md`.
 */
import { Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { minimalChange } from './editor-reload'

export function applyReload(view: EditorView, text: string): void {
  const change = minimalChange(view.state.doc.toString(), text)
  if (change === null) return
  view.dispatch({
    changes: change,
    annotations: [Transaction.addToHistory.of(false)],
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/desktop && pnpm exec vitest run --project dom src/renderer/src/lib/apply-reload.test.tsx`
Expected: PASS (all three tests green).

- [ ] **Step 5: Commit**

```bash
cd apps/desktop && git add src/renderer/src/lib/apply-reload.ts src/renderer/src/lib/apply-reload.test.tsx && git commit -m "feat(editor): applyReload dispatches reloads out of undo history

Claude goes brr.. via Dash"
```

---

### Task 3: Wire `applyReload` into the reload effect

Replace the whole-document dispatch in `EditorPane`'s reload effect with `applyReload`. `base` still advances first; the `merged` write-back is unchanged; `conflict`/`none` untouched. There is no dom test for `EditorPane` itself (it is trpc/atom-heavy); Task 2 covers the dispatch behavior. This task is verified by typecheck + the full suites staying green.

**Files:**
- Modify: `apps/desktop/src/renderer/src/composites/EditorPane.tsx` (import + lines 261-267)

- [ ] **Step 1: Add the import**

In `apps/desktop/src/renderer/src/composites/EditorPane.tsx`, beside the existing `import { decideReload } from '@/lib/editor-reload'` (line 31), add:

```ts
import { applyReload } from '@/lib/apply-reload'
```

- [ ] **Step 2: Replace the dispatch block**

Replace this block (currently lines 261-267):

```ts
      baseRef.current = decision.text
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: decision.text },
      })
      if (decision.kind === 'merged') {
        void trpc.notes.write.mutate({ remote, path, text: decision.text })
      }
```

with:

```ts
      baseRef.current = decision.text
      applyReload(view, decision.text)
      if (decision.kind === 'merged') {
        void trpc.notes.write.mutate({ remote, path, text: decision.text })
      }
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit`
Expected: exit 0, no errors. (Leave the line-20 `EditorSelection` import alone — it is still used at `EditorPane.tsx:149` for the plain-editor caret.)

- [ ] **Step 4: Run the dom suite**

Run: `cd apps/desktop && pnpm exec vitest run --project dom`
Expected: PASS (67+ tests; the new `apply-reload` tests included).

- [ ] **Step 5: Commit**

```bash
cd apps/desktop && git add src/renderer/src/composites/EditorPane.tsx && git commit -m "feat(editor): reload through applyReload so undo skips foreign text

Resolves notes-editor OQ3.

Claude goes brr.. via Dash"
```

---

### Task 4: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `cd apps/desktop && pnpm exec node node_modules/typescript/bin/tsc --noEmit`
Expected: exit 0.

- [ ] **Step 2: Node suite** (~120s — background it if the runner supports it)

Run: `cd apps/desktop && pnpm exec vitest run --project node`
Expected: PASS (744+ tests; `minimalChange` added to the existing file).

- [ ] **Step 3: Dom suite**

Run: `cd apps/desktop && pnpm exec vitest run --project dom`
Expected: PASS.

- [ ] **Step 4: Shared suite** (unchanged by this work, run as a regression guard)

Run: `cd ../../packages/shared && pnpm exec vitest run`
Expected: PASS (210+ tests).

- [ ] **Step 5: Confirm the working tree is clean**

Run: `cd ../../ && git status --short && git log --oneline -4`
Expected: clean tree; the three feature commits plus the spec commit on `main`.

---

## Notes for the executor

- **Live-check (UI verification ceiling):** the undo behavior itself can only be *unit*-verified here (Task 2). There is no CDP/dev-app driving in this environment, so hand the user a manual check for the real app if they want it confirmed end-to-end: open a note, edit it, have the agent/another process write the file, then press ⌘Z and confirm your keystrokes unwind while the foreign text and caret stay put.
- **Do not push.** Commit locally per task; the user says "push it" explicitly at each gate.
- **`EditorSelection` import:** stays. Task 3 removes the last full-doc replace, but `EditorSelection` is still used at `EditorPane.tsx:149` for the plain-editor caret — do not touch the line-20 import.
