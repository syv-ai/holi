/**
 * The vault snapshot as the file tree's data: a flat record from path to
 * name, kind and children.
 *
 * Ids are paths. A folder exists if a doc is inside it or it is named in
 * `folders`: the on-disk directories (`snapshot.dirs`) plus client-only ones
 * still being named, so an empty or fully filtered folder still shows.
 *
 * A folder document (a claim's `folder`, such as an app's `Budget.app`) is a
 * folder with `isDocument` set: it holds its files like any folder, and sorts
 * with the files, since it reads as one. `isDocument` says which folders are:
 * a `.app` folder with nothing to open (a macOS app copied in, an app whose
 * first file is still being written) is a folder.
 */

export const ROOT_ID = '__root__'

export interface TreeItemData {
  name: string
  isFolder: boolean
  /** A folder that is one document, such as a vault app's bundle. */
  isDocument: boolean
  children: string[]
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function buildTreeData(
  paths: string[],
  folders: string[] = [],
  isDocument: (folder: string, has: (path: string) => boolean) => boolean = () => false,
): Record<string, TreeItemData> {
  const root: TreeItemData = { name: '', isFolder: true, isDocument: false, children: [] }
  const present = new Set(paths)
  const has = (path: string) => present.has(path)
  const data: Record<string, TreeItemData> = { [ROOT_ID]: root }

  // Returns the node, so callers need not re-index under
  // `noUncheckedIndexedAccess`.
  const ensureFolder = (path: string): TreeItemData => {
    const existing = data[path]
    if (existing) return existing
    const node: TreeItemData = {
      name: baseName(path),
      isFolder: true,
      isDocument: isDocument(path, has),
      children: [],
    }
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
    data[path] = { name: path.slice(slash + 1), isFolder: false, isDocument: false, children: [] }
    parent.children.push(path)
  }

  // Hidden-entry filtering happens upstream in FileTree.
  const nameOf = (id: string): string => data[id]?.name ?? ''

  const rank = (id: string) => (data[id]?.isFolder && !data[id]?.isDocument ? 0 : 1)
  for (const item of Object.values(data)) {
    item.children.sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b)))
  }

  return data
}
