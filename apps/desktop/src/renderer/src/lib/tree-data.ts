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
  const data: Record<string, TreeItemData> = {
    [ROOT_ID]: { name: '', isFolder: true, children: [] },
  }

  const ensureFolder = (path: string): void => {
    if (data[path]) return
    data[path] = { name: baseName(path), isFolder: true, children: [] }
    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? ROOT_ID : path.slice(0, slash)
    if (parent !== ROOT_ID) ensureFolder(parent)
    data[parent].children.push(path)
  }

  for (const folder of pendingFolders) ensureFolder(folder)

  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? ROOT_ID : path.slice(0, slash)
    if (parent !== ROOT_ID) ensureFolder(parent)
    data[path] = { name: path.slice(slash + 1), isFolder: false, children: [] }
    data[parent].children.push(path)
  }

  data[ROOT_ID].children = data[ROOT_ID].children.filter((id) => !HIDDEN_ROOTS.has(data[id].name))

  const rank = (id: string) => (data[id].isFolder ? 0 : 1)
  for (const item of Object.values(data)) {
    item.children.sort((a, b) => rank(a) - rank(b) || data[a].name.localeCompare(data[b].name))
  }

  return data
}
