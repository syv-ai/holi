/**
 * The file tree, derived from doc paths and nothing else.
 *
 * **Folders are directories, not rows.** They used to be records with stable
 * ids, a `folderId` on every node, and a rename that went through the server —
 * which is why this module also carried `renameTarget` (some folders were
 * synthesized and so had no id to rename by) and `pruneEmptyFolders` (deleting
 * the last doc in one left an orphan row that rendered as a folder nobody could
 * remove).
 *
 * Both are gone, and neither needed replacing. Git does not track an empty
 * directory, so a folder exists exactly when a file is in it — and since the
 * only way a folder node comes into being here is while placing a doc inside
 * it, an empty folder is now *unrepresentable* rather than merely hidden. That
 * is `notes-editor.md` FR-13's "the old vestigial empty-folder problem and its
 * display-level workaround both disappear: there is no row to orphan."
 *
 * The tree is a projection of the pushed snapshot, which main derives from a
 * directory walk — the filesystem, one hop removed. A note created by a pull or
 * by the agent therefore appears without anyone refetching.
 */

export type TreeNode =
  | { kind: 'folder'; name: string; path: string; children: TreeNode[] }
  | { kind: 'doc'; name: string; path: string }

/** Vault-managed roots hidden from the tree by default (D6). */
const HIDDEN_ROOTS = new Set(['.claude', '.holi', 'AGENTS.md', 'MEMORY.md', 'CLAUDE.md'])

export function buildTree(paths: string[]): TreeNode[] {
  const roots: TreeNode[] = []
  const folders = new Map<string, Extract<TreeNode, { kind: 'folder' }>>()

  function ensureFolder(path: string): Extract<TreeNode, { kind: 'folder' }> {
    const existing = folders.get(path)
    if (existing) return existing
    const node: Extract<TreeNode, { kind: 'folder' }> = {
      kind: 'folder',
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      children: [],
    }
    folders.set(path, node)
    const parent = path.includes('/') ? ensureFolder(path.slice(0, path.lastIndexOf('/'))) : null
    ;(parent ? parent.children : roots).push(node)
    return node
  }

  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? null : ensureFolder(path.slice(0, slash))
    const node: TreeNode = { kind: 'doc', name: path.slice(slash + 1), path }
    ;(parent ? parent.children : roots).push(node)
  }

  sortLevel(roots)
  for (const folder of folders.values()) sortLevel(folder.children)
  return roots.filter((n) => !HIDDEN_ROOTS.has(n.name))
}

/** Folders first, then alphabetical within each group — what every file tree
 *  does, and what people expect without being told. */
function sortLevel(nodes: TreeNode[]): void {
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  )
}
