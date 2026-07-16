/**
 * The file tree's reducer. Pure and tested directly, the way `applyTasksEvent` is —
 * no React, no jotai store, no Electron.
 */
import { describe, expect, it } from 'vitest'
import { applyDocsEvent, needsFolderRefetch } from '../src/renderer/src/state/vaults'
import type { DocMeta, Folder } from '@holi/shared'

const doc = (over: Partial<DocMeta> = {}): DocMeta =>
  ({
    id: 'd1',
    vaultId: 'v1',
    path: 'a.md',
    kind: 'note',
    createdAt: '2026-07-16T00:00:00Z',
    updatedAt: '2026-07-16T00:00:00Z',
    ...over,
  }) as DocMeta

const folder = (path: string, id = path): Folder => ({ id, vaultId: 'v1', path }) as Folder

const state = (docs: DocMeta[], folders: Folder[] = []) => ({ docs, folders })

describe('applyDocsEvent', () => {
  it('adds a doc someone else created — the whole point of the slice', () => {
    const next = applyDocsEvent(state([doc()]), { type: 'created', doc: doc({ id: 'd2', path: 'b.md' }) })
    expect(next.docs.map((d) => d.path)).toEqual(['a.md', 'b.md'])
  })

  it('replaces a renamed doc in place rather than adding a second copy', () => {
    const next = applyDocsEvent(state([doc(), doc({ id: 'd2', path: 'b.md' })]), {
      type: 'renamed',
      doc: doc({ id: 'd2', path: 'c.md' }),
    })
    expect(next.docs.map((d) => d.path)).toEqual(['a.md', 'c.md'])
    expect(next.docs).toHaveLength(2)
  })

  it('drops a deleted doc', () => {
    const next = applyDocsEvent(state([doc(), doc({ id: 'd2', path: 'b.md' })]), {
      type: 'deleted',
      doc: doc({ id: 'd2', path: 'b.md' }),
    })
    expect(next.docs.map((d) => d.id)).toEqual(['d1'])
  })

  // The server is the authority and the frame is the newer truth; a duplicate id would
  // render the same note twice in the tree.
  it('does not duplicate a doc that is already known', () => {
    const next = applyDocsEvent(state([doc()]), { type: 'created', doc: doc({ path: 'renamed-by-race.md' }) })
    expect(next.docs).toHaveLength(1)
    expect(next.docs[0]?.path).toBe('renamed-by-race.md')
  })

  it('leaves folders alone — DocsEvent carries a DocMeta and nothing else', () => {
    const folders = [folder('notes')]
    const next = applyDocsEvent(state([doc()], folders), { type: 'created', doc: doc({ id: 'd2', path: 'b.md' }) })
    expect(next.folders).toBe(folders)
  })

  it('does not mutate the state it was given', () => {
    const before = state([doc()])
    applyDocsEvent(before, { type: 'created', doc: doc({ id: 'd2', path: 'b.md' }) })
    expect(before.docs).toHaveLength(1)
  })
})

/**
 * Folder rows have no channel of their own: `DocsEvent` carries a DocMeta, so a note
 * created into a brand-new folder adds no `folders` row locally. `buildTree` synthesizes
 * one with `folderId: null` so the tree still renders — but `foldersAtom` drives the
 * board's lanes off real rows, and a null id is un-renameable. Cheaper to notice the gap
 * and refetch than to invent a row the server did not send.
 */
describe('needsFolderRefetch', () => {
  it('is true when a doc lands in a folder we have never heard of', () => {
    expect(needsFolderRefetch(state([], []), doc({ path: 'projects/new.md' }))).toBe(true)
  })

  it('is false when the folder is already known', () => {
    expect(needsFolderRefetch(state([], [folder('projects')]), doc({ path: 'projects/new.md' }))).toBe(false)
  })

  it('is false for a doc at the root — there is no folder to miss', () => {
    expect(needsFolderRefetch(state([], []), doc({ path: 'a.md' }))).toBe(false)
  })

  it('checks every ancestor, not just the immediate parent', () => {
    expect(needsFolderRefetch(state([], [folder('a'), folder('a/b/c')]), doc({ path: 'a/b/c/d.md' }))).toBe(true)
  })

  it('is false when every ancestor is known', () => {
    const folders = [folder('a'), folder('a/b'), folder('a/b/c')]
    expect(needsFolderRefetch(state([], folders), doc({ path: 'a/b/c/d.md' }))).toBe(false)
  })
})
