/**
 * File tree from SERVER METADATA — never a disk scan (vaults-collab PRD
 * §Folder hierarchy). Folder identity rows carry stable IDs (D27); folders
 * that exist only as doc-path prefixes get synthesized nodes (id null).
 */

export interface TreeDocInput {
  id: string
  path: string
}
export interface TreeFolderInput {
  id: string
  path: string
}

export type TreeNode =
  | { kind: 'folder'; name: string; path: string; folderId: string | null; children: TreeNode[] }
  | { kind: 'doc'; name: string; path: string; docId: string }

/** Vault-managed roots hidden from the tree by default (D6). */
const HIDDEN_ROOTS = new Set(['.claude', '.holi', 'AGENTS.md', 'MEMORY.md', 'CLAUDE.md'])

export function buildTree(docs: TreeDocInput[], folders: TreeFolderInput[]): TreeNode[] {
  const folderIds = new Map(folders.map((f) => [f.path, f.id]))
  const roots: TreeNode[] = []
  const folderNodes = new Map<string, Extract<TreeNode, { kind: 'folder' }>>()

  function ensureFolder(path: string): Extract<TreeNode, { kind: 'folder' }> {
    const existing = folderNodes.get(path)
    if (existing) return existing
    const name = path.split('/').at(-1)!
    const node: Extract<TreeNode, { kind: 'folder' }> = {
      kind: 'folder',
      name,
      path,
      folderId: folderIds.get(path) ?? null,
      children: [],
    }
    folderNodes.set(path, node)
    const parent = path.includes('/') ? ensureFolder(path.slice(0, path.lastIndexOf('/'))) : null
    ;(parent ? parent.children : roots).push(node)
    return node
  }

  for (const f of folders) ensureFolder(f.path)
  for (const d of docs) {
    const slash = d.path.lastIndexOf('/')
    const parent = slash === -1 ? null : ensureFolder(d.path.slice(0, slash))
    const node: TreeNode = { kind: 'doc', name: d.path.slice(slash + 1), path: d.path, docId: d.id }
    ;(parent ? parent.children : roots).push(node)
  }

  sortLevel(roots)
  for (const f of folderNodes.values()) sortLevel(f.children)
  return roots.filter((n) => !HIDDEN_ROOTS.has(n.name))
}

function sortLevel(nodes: TreeNode[]): void {
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  )
}
