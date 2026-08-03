/**
 * The vault snapshot as headless-tree's flat data record.
 *
 * headless-tree consumes a `Record<id, {name,isFolder,children}>` addressed by a
 * synchronous data loader (getItem/getChildren). Ids are paths; folders exist iff
 * a doc is inside them, OR they are named in `folders` — the real on-disk
 * directories (`snapshot.dirs`, kept alive by a `.gitkeep`) plus the transient,
 * client-only ones still being named. That second list is what lets an empty
 * folder, or one whose whole content is filtered away, still show (spec §Empty
 * folders).
 */
export const ROOT_ID = '__root__'

export interface TreeItemData {
  name: string
  isFolder: boolean
  children: string[]
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function buildTreeData(
  paths: string[],
  folders: string[] = [],
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

  for (const folder of folders) ensureFolder(folder)

  for (const path of paths) {
    const slash = path.lastIndexOf('/')
    const parent = slash === -1 ? root : ensureFolder(path.slice(0, slash))
    data[path] = { name: path.slice(slash + 1), isFolder: false, children: [] }
    parent.children.push(path)
  }

  // Hidden-entry filtering (dotfiles) happens upstream in FileTree, keyed off the
  // per-vault show/hide toggle, so this stays a pure projection of the paths given.
  const nameOf = (id: string): string => data[id]?.name ?? ''

  const rank = (id: string) => (data[id]?.isFolder ? 0 : 1)
  for (const item of Object.values(data)) {
    item.children.sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)))
  }

  return data
}
