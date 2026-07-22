/**
 * The tree, from paths alone.
 *
 * The old signature took a `folders[]` beside the docs, because folders were
 * rows in a database with stable ids and a lifetime of their own. They are
 * directories now (`glossary.md` §Area), and git does not track an empty one —
 * so a folder exists exactly when a file is in it, and the whole vestigial-empty-
 * folder problem (D56) and its display-level workaround go with the rows.
 */
import { describe, expect, it } from 'vitest'
import { buildTree, type TreeNode } from '../src/renderer/src/lib/tree'

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name))
}

describe('buildTree', () => {
  it('nests docs under their folders, folders first, alphabetical', () => {
    const tree = buildTree(['zebra.md', 'projects/q2/plan.md', 'alpha.md'])

    expect(names(tree)).toEqual(['projects/', 'alpha.md', 'zebra.md'])
    const projects = tree[0]!
    if (projects.kind !== 'folder') throw new Error('expected folder')
    expect(names(projects.children)).toEqual(['q2/'])
    const q2 = projects.children[0]!
    if (q2.kind !== 'folder') throw new Error('expected folder')
    expect(q2.children[0]).toEqual({ kind: 'doc', name: 'plan.md', path: 'projects/q2/plan.md' })
  })

  it('builds every intermediate folder from the path', () => {
    // Nothing declares folders any more; a doc three deep implies both of them.
    const tree = buildTree(['a/b/c.md'])

    expect(names(tree)).toEqual(['a/'])
    const a = tree[0]!
    if (a.kind !== 'folder') throw new Error('expected folder')
    expect(names(a.children)).toEqual(['b/'])
  })

  it('hides Holi-managed root entries by default (D6)', () => {
    const tree = buildTree(['AGENTS.md', 'MEMORY.md', '.holi/settings.json', 'real.md'])

    expect(names(tree)).toEqual(['real.md'])
  })

  it('cannot produce an empty folder at all', () => {
    // The D56 suite that used to live here tested pruning folders whose last
    // doc was deleted. There is nothing left to prune: a folder is only ever
    // created while placing a doc into it, so an empty one is unrepresentable
    // rather than merely hidden.
    const tree = buildTree(['keep.md'])

    expect(names(tree)).toEqual(['keep.md'])
  })

  it('keeps a folder whose only doc is in a subfolder', () => {
    const tree = buildTree(['a/b/deep.md'])

    expect(names(tree)).toEqual(['a/'])
    const a = tree[0]!
    if (a.kind !== 'folder') throw new Error('expected folder')
    expect(names(a.children)).toEqual(['b/'])
  })
})
