/**
 * `notes.backrefs` returns `srcDocId` only — no path, no title — so naming the notes that
 * link somewhere is a client-side join against docsAtom. Pure, so tested directly.
 */
import { describe, expect, it } from 'vitest'
import { namedBackrefs } from '../src/renderer/src/state/vaults'
import type { DocMeta } from '@holi/shared'

const doc = (id: string, path: string) => ({ id, path }) as DocMeta

describe('namedBackrefs', () => {
  it('names each linking note from the docs we already have', () => {
    const named = namedBackrefs(
      [{ srcDocId: 'd1', occurrences: 2 }],
      [doc('d1', 'projects/plan.md'), doc('d2', 'other.md')],
    )
    expect(named).toEqual([{ srcDocId: 'd1', occurrences: 2, path: 'projects/plan.md' }])
  })

  // A link can come from a doc that is not in this vault's list — never render `undefined`
  // into a confirm dialog someone is about to make a delete decision from.
  it('falls back to a readable label for a doc it cannot see', () => {
    const named = namedBackrefs([{ srcDocId: 'ghost', occurrences: 1 }], [doc('d1', 'a.md')])
    expect(named).toEqual([{ srcDocId: 'ghost', occurrences: 1, path: 'a note you cannot see' }])
  })

  it('is empty when nothing links here', () => {
    expect(namedBackrefs([], [doc('d1', 'a.md')])).toEqual([])
  })
})
