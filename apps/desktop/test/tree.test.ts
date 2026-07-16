import { describe, expect, it } from 'vitest'
import { buildTree, renameTarget, type TreeNode } from '../src/renderer/src/lib/tree'

const doc = (id: string, path: string) => ({ id, path })
const folder = (id: string, path: string) => ({ id, path })

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name))
}

describe('buildTree', () => {
  it('nests docs under their folders, folders first, alphabetical', () => {
    const tree = buildTree(
      [doc('d1', 'zebra.md'), doc('d2', 'projects/q2/plan.md'), doc('d3', 'alpha.md')],
      [folder('f1', 'projects'), folder('f2', 'projects/q2')],
    )
    expect(names(tree)).toEqual(['projects/', 'alpha.md', 'zebra.md'])
    const projects = tree[0]!
    if (projects.kind !== 'folder') throw new Error('expected folder')
    expect(names(projects.children)).toEqual(['q2/'])
    const q2 = projects.children[0]!
    if (q2.kind !== 'folder') throw new Error('expected folder')
    expect(names(q2.children)).toEqual(['plan.md'])
    expect(q2.children[0]).toMatchObject({ kind: 'doc', docId: 'd2', path: 'projects/q2/plan.md' })
  })

  it('synthesizes folder nodes missing an identity row (doc deeper than known folders)', () => {
    const tree = buildTree([doc('d1', 'a/b/c.md')], [])
    expect(names(tree)).toEqual(['a/'])
    const a = tree[0]!
    if (a.kind !== 'folder') throw new Error('expected folder')
    expect(names(a.children)).toEqual(['b/'])
  })

  it('hides Holi-managed root entries by default (D6)', () => {
    const tree = buildTree(
      [doc('d1', 'AGENTS.md'), doc('d2', 'MEMORY.md'), doc('d3', '.holi/settings.json'), doc('d4', 'real.md')],
      [folder('f1', '.claude'), folder('f2', '.holi')],
    )
    expect(names(tree)).toEqual(['real.md'])
  })
})

/**
 * D56. Shipping delete CREATES this problem — until now you could not delete a note from
 * the tree at all, so nobody could make an empty folder. Deleting the last note in one
 * leaves an orphan `folders` row that `buildTree` would happily render as a folder you
 * cannot remove (there is no deleteFolder, and folders only ever come into being
 * implicitly via `ensureAncestorFolders`).
 *
 * The fix is display, and it is confined to the tree: GC'ing the row would silently
 * unfile every task pointing at that folder as its `area` (D38's ON DELETE SET NULL).
 * A folder with no docs can legitimately still be a board lane full of tasks — docs and
 * tasks are different populations over the same folders. Since nobody can deliberately
 * create an empty folder, an empty one is always vestigial, so hiding it loses nothing.
 */
describe('buildTree hides vestigial empty folders (D56)', () => {
  it('drops a folder whose last doc was deleted', () => {
    const tree = buildTree([doc('d1', 'keep.md')], [folder('f1', 'emptied')])
    expect(names(tree)).toEqual(['keep.md'])
  })

  it('keeps a folder whose only doc is in a SUBfolder', () => {
    const tree = buildTree([doc('d1', 'a/b/deep.md')], [folder('f1', 'a'), folder('f2', 'a/b')])
    expect(names(tree)).toEqual(['a/'])
    const a = tree[0]!
    if (a.kind !== 'folder') throw new Error('expected folder')
    expect(names(a.children)).toEqual(['b/'])
  })

  it('drops an empty subfolder while keeping its populated parent', () => {
    const tree = buildTree([doc('d1', 'a/note.md')], [folder('f1', 'a'), folder('f2', 'a/empty')])
    const a = tree[0]!
    if (a.kind !== 'folder') throw new Error('expected folder')
    expect(names(a.children)).toEqual(['note.md'])
  })

  it('drops a whole empty branch, not just its leaf', () => {
    const tree = buildTree([doc('d1', 'keep.md')], [folder('f1', 'x'), folder('f2', 'x/y'), folder('f3', 'x/y/z')])
    expect(names(tree)).toEqual(['keep.md'])
  })
})

/**
 * `buildTree` synthesizes a folder node for any path prefix that has no `folders` row,
 * giving it `folderId: null` — and `notes.renameFolder` takes a folderId. So some rows
 * are structurally un-renameable, and the UI must simply not offer it there rather than
 * paper over it by renaming the contained docs one at a time (that is renameFolder's job,
 * and it does it better: one link-rewrite pass, one conflict check).
 */
describe('renameTarget', () => {
  it('names a doc by its docId', () => {
    expect(renameTarget({ kind: 'doc', name: 'a.md', path: 'a.md', docId: 'd1' })).toEqual({
      kind: 'note',
      docId: 'd1',
    })
  })

  it('names a real folder by its folderId', () => {
    expect(
      renameTarget({ kind: 'folder', name: 'a', path: 'a', folderId: 'f1', children: [] }),
    ).toEqual({ kind: 'folder', folderId: 'f1' })
  })

  it('gives no target for a synthesized folder — there is no id to rename by', () => {
    expect(
      renameTarget({ kind: 'folder', name: 'a', path: 'a', folderId: null, children: [] }),
    ).toBeNull()
  })
})
