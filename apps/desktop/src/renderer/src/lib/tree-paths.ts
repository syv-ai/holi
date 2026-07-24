/** Small, pure path helpers for the file tree. Vault paths are POSIX-style
 *  ('/'-separated), relative to the vault root. */

export const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export const parentOf = (path: string): string => {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

export const joinPath = (parent: string, name: string): string =>
  parent ? `${parent}/${name}` : name

/** New notes default to markdown; an explicit extension is left alone. */
export const withMdExtension = (name: string): string =>
  /\.[^./]+$/.test(name) ? name : `${name}.md`

/** The [start, end] of the basename minus its extension — what a rename input
 *  should pre-select so the user edits the name, not the `.md` (VS Code). */
export const renameBasenameRange = (name: string): [number, number] => {
  const dot = name.lastIndexOf('.')
  return [0, dot > 0 ? dot : name.length]
}
