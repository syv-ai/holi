import { describe, expect, it } from 'vitest'
import {
  planMoveInto,
  planRenameFolder,
} from '@/lib/tree-actions'

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
