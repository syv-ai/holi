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
  return pruneEmptyFolders(roots).filter((n) => !HIDDEN_ROOTS.has(n.name))
}

/** What a rename of this row would target, or null when it cannot be renamed. */
export type RenameTarget = { kind: 'note'; docId: string } | { kind: 'folder'; folderId: string }

/**
 * Can this row be renamed, and as what?
 *
 * `buildTree` synthesizes a folder node for any path prefix with no `folders` row, and
 * gives it `folderId: null` — while `notes.renameFolder` takes a folderId. So some rows
 * are structurally un-renameable and the UI must not offer it there. Kept out of the JSX
 * because "can this be renamed" is a rule, not a rendering detail.
 *
 * Do NOT paper over the null case by renaming the contained docs one by one: that is
 * `renameFolder`'s job and it does it properly — one link-rewrite pass per doc, and one
 * up-front conflict check across every destination.
 */
export function renameTarget(node: TreeNode): RenameTarget | null {
  if (node.kind === 'doc') return { kind: 'note', docId: node.docId }
  return node.folderId === null ? null : { kind: 'folder', folderId: node.folderId }
}

/**
 * Drop folders with no docs anywhere beneath them (D56).
 *
 * Folders only come into being implicitly, via `ensureAncestorFolders` when a doc's path
 * contains a `/` — there is no createFolder — so **an empty folder is always vestigial**:
 * the last doc in it was deleted or moved away, and there is no deleteFolder to remove
 * the row. Hiding it therefore loses nothing a user meant to have.
 *
 * Confined to the tree, deliberately. GC'ing the `folders` row instead would silently
 * unfile every task pointing at it as its `area` (D38 — `ON DELETE SET NULL`): a folder
 * with no docs can legitimately still be a board lane full of tasks, because docs and
 * tasks are different populations over the same folders. So `foldersAtom` keeps feeding
 * the lanes from the same rows; only this rendering changes.
 */
function pruneEmptyFolders(nodes: TreeNode[]): TreeNode[] {
  const kept: TreeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'doc') {
      kept.push(node)
      continue
    }
    node.children = pruneEmptyFolders(node.children)
    if (node.children.length > 0) kept.push(node)
  }
  return kept
}

function sortLevel(nodes: TreeNode[]): void {
  nodes.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1,
  )
}
