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
 * `notes-editor.md` §Open question 2 — "is the editor's own save distinguished
 * by path+mtime, by pausing the watcher, or by content comparison?" — is closed
 * by these tests. Content comparison is the only one that cannot race.
 */
import { describe, expect, it } from 'vitest'
import { decideReload, minimalChange } from '../src/renderer/src/lib/editor-reload'

describe('decideReload', () => {
  it('does nothing when disk matches base, whoever did the writing', () => {
    // The editor's own autosave lands here, and so does an agent write that
    // happened to produce identical bytes, and so does a pull that changed a
    // different file. All three are the same non-event.
    expect(decideReload('hello\n', 'hello\n', 'hello\n')).toEqual({ kind: 'none' })
  })

  it('still does nothing when the buffer has moved on but disk has not', () => {
    // Mid-typing, no external write. The most common state in the whole app —
    // if this reloaded, it would throw away every keystroke since the last save
    // on any unrelated snapshot push, and the snapshot push carries no path so
    // there are a great many unrelated ones.
    expect(decideReload('hello\n', 'hello world\n', 'hello\n')).toEqual({ kind: 'none' })
  })

  it('reloads silently when the buffer is clean', () => {
    // FR-11: a clean merge is silent. This is the overwhelmingly common
    // external-write case, because autosave fires on idle.
    expect(decideReload('hello\n', 'hello\n', 'from a teammate\n')).toEqual({
      kind: 'reload',
      text: 'from a teammate\n',
    })
  })

  it('merges when both sides moved and they do not overlap', () => {
    const base = 'one\ntwo\nthree\n'
    const mine = 'ONE\ntwo\nthree\n'
    const theirs = 'one\ntwo\nTHREE\n'

    expect(decideReload(base, mine, theirs)).toEqual({ kind: 'merged', text: 'ONE\ntwo\nTHREE\n' })
  })

  it('reports a conflict rather than picking a side', () => {
    // A merger that silently chose would remove the feature: the report is what
    // routes this to the vault's ordinary reconcile affordance.
    const result = decideReload('one\n', 'mine\n', 'theirs\n')

    expect(result.kind).toBe('conflict')
    if (result.kind !== 'conflict') throw new Error('expected a conflict')
    expect(result.regions.length).toBeGreaterThan(0)
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
