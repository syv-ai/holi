import { describe, expect, it } from 'vitest'
import { buildTree, type TreeNode } from '../src/renderer/src/lib/tree'

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
