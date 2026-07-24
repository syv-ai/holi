/**
 * The vault snapshot as headless-tree's flat data record.
 *
 * headless-tree consumes a `Record<id, {name,isFolder,children}>` addressed by a
 * synchronous data loader (getItem/getChildren). Ids are paths; folders exist iff
 * a doc is inside them (git tracks no empty directory — see the old lib/tree.ts),
 * with the sole exception of `pendingFolders`: transient, client-only folders that
 * the UI shows until the first note lands inside (spec §Empty folders).
 */
export const ROOT_ID = '__root__'

export interface TreeItemData {
  name: string
  isFolder: boolean
  children: string[]
}

/** Vault-managed roots hidden from the tree by default (D6). */
const HIDDEN_ROOTS = new Set(['.claude', '.holi', 'AGENTS.md', 'MEMORY.md', 'CLAUDE.md'])

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function buildTreeData(
  paths: string[],
  pendingFolders: string[] = [],
): Record<string, TreeItemData> {
  const root: TreeItemData = { name: '', isFolder: true, children: [] }
  const data: Record<string, TreeItemData> = { [ROOT_ID]: root }

  // Returns the folder node so callers hold a reference rather than re-indexing
  // (keeps the whole function clean under `noUncheckedIndexedAccess`).
  const ensureFolder = (path: string): TreeItemData => {
    const existing = data[path]
    if (existing) return existing
    const node: TreeItemData = { name: baseName(path), isFolder: true, children: [] }
    data[path] = node
    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? root : ensureFolder(path.slice(0, slash))
    parent.children.push(path)
    return node
  }

  for (const folder of pendingFolders) ensureFolder(folder)

  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? root : ensureFolder(path.slice(0, slash))
    data[path] = { name: path.slice(slash + 1), isFolder: false, children: [] }
    parent.children.push(path)
  }

  const nameOf = (id: string): string => data[id]?.name ?? ''
  root.children = root.children.filter((id) => !HIDDEN_ROOTS.has(nameOf(id)))

  const rank = (id: string) => (data[id]?.isFolder ? 0 : 1)
  for (const item of Object.values(data)) {
    item.children.sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)))
  }

  return data
}
