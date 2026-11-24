import { describe, expect, it } from 'vitest'
import { planMoveFolders, planMoveInto, planRenameFolder } from '@/lib/tree-actions'

const DOCS = ['a.md', 'notes/b.md', 'notes/deep/c.md', 'other/d.md']

describe('planMoveInto', () => {
  it('remaps a folder under the destination, preserving nested structure', () => {
    expect(planMoveInto(DOCS, ['notes'], 'other')).toEqual([
      { from: 'notes/b.md', to: 'other/notes/b.md' },
      { from: 'notes/deep/c.md', to: 'other/notes/deep/c.md' },
    ])
  })
  it('drops no-op moves (already in the destination)', () => {
    expect(planMoveInto(DOCS, ['notes/b.md'], 'notes')).toEqual([])
  })
})

describe('planMoveFolders', () => {
  const DIRS = ['notes', 'notes/deep', 'other', 'empty']

  it('names each dragged folder, empty or not, where it lands', () => {
    expect(planMoveFolders(DIRS, ['empty', 'notes'], 'other')).toEqual([
      { from: 'empty', to: 'other/empty' },
      { from: 'notes', to: 'other/notes' },
    ])
  })
  it('leaves files out, and a folder already in the destination', () => {
    expect(planMoveFolders(DIRS, ['a.md', 'notes/deep'], 'notes')).toEqual([])
  })
})

describe('planRenameFolder', () => {
  it('remaps every file under the folder to the new name', () => {
    const plan = planRenameFolder(DOCS, 'notes', 'archive')
    expect(plan.dest).toBe('archive')
    expect(plan.files.sort()).toEqual(['notes/b.md', 'notes/deep/c.md'])
    expect(plan.moves).toEqual([
      { from: 'notes/b.md', to: 'archive/b.md' },
      { from: 'notes/deep/c.md', to: 'archive/deep/c.md' },
    ])
  })
  it('reports an empty transient folder with no moves', () => {
    const plan = planRenameFolder(DOCS, 'empty', 'renamed')
    expect(plan.files).toEqual([])
    expect(plan.moves).toEqual([])
  })
})
