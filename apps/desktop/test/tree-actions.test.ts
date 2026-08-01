import { describe, expect, it } from 'vitest'
import {
  deleteLabel,
  filesUnder,
  planDuplicate,
  planMoveInto,
  planPaste,
  planRenameFolder,
} from '../src/renderer/src/lib/tree-actions'

const DOCS = [
  'a.md',
  'notes/b.md',
  'notes/deep/c.md',
  'other/d.md',
]

describe('filesUnder', () => {
  it('fans a folder out to its files and dedups overlapping targets', () => {
    expect(filesUnder(DOCS, ['notes']).sort()).toEqual(['notes/b.md', 'notes/deep/c.md'])
    // 'notes' and 'notes/deep' overlap — each file appears once.
    expect(filesUnder(DOCS, ['notes', 'notes/deep']).sort()).toEqual([
      'notes/b.md',
      'notes/deep/c.md',
    ])
  })
})

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

describe('planDuplicate', () => {
  it('clones a file to its first free copy name', () => {
    expect(planDuplicate(DOCS, ['a.md'])).toEqual([{ from: 'a.md', to: 'a copy.md' }])
  })
  it('clones a folder subtree under a copied root', () => {
    expect(planDuplicate(DOCS, ['notes'])).toEqual([
      { from: 'notes/b.md', to: 'notes copy/b.md' },
      { from: 'notes/deep/c.md', to: 'notes copy/deep/c.md' },
    ])
  })
})

describe('planPaste', () => {
  it('a cut is a move into the destination', () => {
    expect(planPaste(DOCS, { mode: 'cut', paths: ['a.md'] }, 'notes')).toEqual({
      mode: 'move',
      moves: [{ from: 'a.md', to: 'notes/a.md' }],
    })
  })
  it('a copy into a folder that already holds the name takes the free copy name', () => {
    // Pasting a.md into '' (root) where a.md exists ⇒ collision ⇒ 'a copy.md'.
    expect(planPaste(DOCS, { mode: 'copy', paths: ['a.md'] }, '')).toEqual({
      mode: 'copy',
      copies: [{ from: 'a.md', to: 'a copy.md' }],
    })
  })
  it('a copy into a fresh folder keeps the name', () => {
    expect(planPaste(DOCS, { mode: 'copy', paths: ['a.md'] }, 'other')).toEqual({
      mode: 'copy',
      copies: [{ from: 'a.md', to: 'other/a.md' }],
    })
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

describe('deleteLabel', () => {
  it('counts a multi-selection', () => {
    expect(deleteLabel(['a.md', 'b.md'], 5, false)).toBe('5 notes')
  })
  it('names a folder with its note count', () => {
    expect(deleteLabel(['notes'], 1, true)).toBe('notes/ (1 note)')
    expect(deleteLabel(['notes'], 2, true)).toBe('notes/ (2 notes)')
  })
  it('is just the path for a single file', () => {
    expect(deleteLabel(['a.md'], 1, false)).toBe('a.md')
  })
})
