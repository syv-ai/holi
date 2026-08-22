/**
 * What the editor does when the file changes underneath it.
 *
 * This is plan 4's decision 7 as a function, and it is the whole
 * write-attribution design: **the editor's own save needs no attribution.** It
 * saved, so it advanced `base`; when the watcher reports that write, `disk`
 * equals `base` and nothing happens. No path bookkeeping, no mtime comparison,
 * no pausing the watcher across the write — all three of which race, and one of
 * which (`notes-editor.md` §Risks) is named as the most likely bug in the PRD.
 *
 * `notes-editor.md` §External writes records the answer — content comparison,
 * because it is the only one of the three that cannot race — and these tests are
 * what closed it.
 */
import { describe, expect, it } from 'vitest'
import { normalizeText } from '@holi/shared'
import { decideReload, minimalChange } from '../src/renderer/src/lib/editor-reload'

describe('decideReload', () => {
  it('does nothing when disk matches base, whoever did the writing', () => {
    // The editor's own autosave lands here, and so does an agent write that
    // happened to produce identical bytes, and so does a pull that changed a
    // different file. All three are the same non-event.
    expect(decideReload('hello\n', 'hello\n', 'hello\n', 'note.md')).toEqual({ kind: 'none' })
  })

  it('still does nothing when the buffer has moved on but disk has not', () => {
    // Mid-typing, no external write. The most common state in the whole app —
    // if this reloaded, it would throw away every keystroke since the last save
    // on any unrelated snapshot push, and the snapshot push carries no path so
    // there are a great many unrelated ones.
    expect(decideReload('hello\n', 'hello world\n', 'hello\n', 'note.md')).toEqual({ kind: 'none' })
  })

  it('reloads silently when the buffer is clean', () => {
    // FR-11: a clean merge is silent. This is the overwhelmingly common
    // external-write case, because autosave fires on idle.
    expect(decideReload('hello\n', 'hello\n', 'from a teammate\n', 'note.md')).toEqual({
      kind: 'reload',
      text: 'from a teammate\n',
    })
  })

  it('merges when both sides moved and they do not overlap', () => {
    const base = 'one\ntwo\nthree\n'
    const mine = 'ONE\ntwo\nthree\n'
    const theirs = 'one\ntwo\nTHREE\n'

    expect(decideReload(base, mine, theirs, 'note.md')).toEqual({ kind: 'merged', text: 'ONE\ntwo\nTHREE\n' })
  })

  it('reports a conflict rather than picking a side', () => {
    // A merger that silently chose would remove the feature: the report is what
    // routes this to the vault's ordinary reconcile affordance.
    const result = decideReload('one\n', 'mine\n', 'theirs\n', 'note.md')

    expect(result.kind).toBe('conflict')
    if (result.kind !== 'conflict') throw new Error('expected a conflict')
    expect(result.regions.length).toBeGreaterThan(0)
  })

  /**
   * The commit hook rewrites the file AFTER the editor's save, which is the one
   * thing `base` bookkeeping cannot see coming. Typing `icon: ` and pausing to
   * open the emoji picker is enough: autosave writes the trailing space,
   * `normalize-md` strips it on commit, and the change lands on the very line
   * still being typed on — so the merge had both sides touching one line and
   * reported a conflict over a space nobody typed on purpose.
   */
  describe("Holi's own commit-time tidy is not a foreign edit", () => {
    const withSpace = '---\ntype: daily-note\nicon: \n---\n\n# 22-08-2026\n'
    const tidied = '---\ntype: daily-note\nicon:\n---\n\n# 22-08-2026\n'
    const withEmoji = '---\ntype: daily-note\nicon: \u2b50\ufe0f\n---\n\n# 22-08-2026\n'

    it('rebases onto the tidied file and keeps what is being typed', () => {
      // The buffer is NOT touched: the emoji survives, and the next save writes
      // it. `base` becomes the tidied text so the invariant holds again.
      expect(decideReload(withSpace, withEmoji, tidied, '22-08-2026.md')).toEqual({
        kind: 'rebase',
        text: tidied,
      })
    })

    it('recognises the tidy on a task file, where the rule also reorders keys', () => {
      const messy = '---\nstatus: doing\ntitle: Fix login\n---\n'
      expect(decideReload(messy, `${messy}\nmine\n`, normalizeText(messy, 'task.a.md'), 'task.a.md')).toEqual({
        kind: 'rebase',
        text: normalizeText(messy, 'task.a.md'),
      })
    })

    it('still reloads rather than rebasing when the buffer is clean', () => {
      // Nothing to protect, so take the tidied bytes outright. Rebasing here
      // would leave `base` and the buffer agreeing on text disk does not have.
      expect(decideReload(withSpace, withSpace, tidied, '22-08-2026.md')).toEqual({
        kind: 'reload',
        text: tidied,
      })
    })

    // The narrowness is the point. `relink` rewrites carry real content — a link
    // target that changed because a file was renamed — so treating them as ours
    // and dropping them in favour of the buffer would silently undo the rename.
    it('does NOT treat a content rewrite as its own, even on one line', () => {
      const base = 'see [[old.md]]\n'
      const relinked = 'see [[new.md]]\n'
      const mine = 'see [[old.md]] and more\n'

      expect(decideReload(base, mine, relinked, 'note.md').kind).not.toBe('rebase')
    })
  })
})

describe('minimalChange', () => {
  it('returns null when the texts are identical', () => {
    expect(minimalChange('hello\n', 'hello\n')).toBeNull()
  })

  it('reports a pure insertion as an empty-range change', () => {
    // Foreign edit prepended; nothing of `current` is removed.
    expect(minimalChange('hello', 'TOP\nhello')).toEqual({ from: 0, to: 0, insert: 'TOP\n' })
  })

  it('reports a pure deletion as an empty insert', () => {
    // "one\nt" is common on both sides, so the diff opens at 5, not 4: it deletes
    // "wo\nt" (5..9), leaving "one\nt" + "hree".
    expect(minimalChange('one\ntwo\nthree', 'one\nthree')).toEqual({
      from: 5,
      to: 9,
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
