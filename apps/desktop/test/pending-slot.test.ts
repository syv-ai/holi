/**
 * Where the "new file" / "new folder" input appears in the tree.
 *
 * It used to render at the very top whatever you had clicked, so picking
 * **New File…** on a folder six rows down put the input somewhere else
 * entirely — and then created the file in the right place anyway, which is the
 * worse half: the tree disagreed with what it was about to do.
 */
import { describe, expect, it } from 'vitest'
import { pendingSlot } from '../src/renderer/src/lib/pending-slot'

const rows = [
  { id: 'notes', level: 0 },
  { id: 'notes/a.md', level: 1 },
  { id: 'projects', level: 0 },
  { id: 'top.md', level: 0 },
]

describe('pendingSlot', () => {
  it('opens the input as a child of the folder that was clicked', () => {
    expect(pendingSlot(rows, 'projects')).toEqual({ afterId: 'projects', level: 1 })
  })

  it('opens at the top for the toolbar, which adds to the vault root', () => {
    // The root has no row to sit under. This is the one case the old behaviour
    // got right, and it is the reason nobody noticed the other one for a while.
    expect(pendingSlot(rows, '')).toEqual({ afterId: null, level: 0 })
  })

  it('indents to the depth of what it is going into, not a fixed one', () => {
    // A nested folder. The input has to line up with the children it is about
    // to join, or the tree shows the file landing a level out from where it
    // will actually be created.
    expect(pendingSlot(rows, 'notes/a.md')).toEqual({ afterId: 'notes/a.md', level: 2 })
  })

  it('falls back to the top when the folder is not on screen', () => {
    // A filter or a collapsed ancestor can hide the row that was clicked. The
    // input still has to appear somewhere — an invisible one reads as the
    // command having done nothing.
    expect(pendingSlot(rows, 'archive/2019')).toEqual({ afterId: null, level: 0 })
  })
})
