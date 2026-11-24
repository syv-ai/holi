import type { NativeWorkingCopy } from './working-copy'
import { recoveryArtifactNames, recoveryDirectories } from './working-copy-recovery'
import { nativeIO } from './native-posix.ios'
import { knownFolders } from '@nativescript/core'

function checked<T>(operation: (error: interop.Reference<NSError>) => T): T {
  const error = new interop.Reference<NSError>()
  const value = operation(error)
  if (error.value) throw new Error(error.value.localizedDescription)
  return value
}

function dictionary(value: NSDictionary<string, NSObject>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (let index = 0; index < Number(value.allKeys.count); index++) {
    const key = String(value.allKeys.objectAtIndex(index))
    result[key] = value.objectForKey(key)
  }
  return result
}

function entries(value: NSArray<NSDictionary<string, NSObject>>): Record<string, unknown>[] {
  return Array.from({ length: Number(value.count) }, (_, index) =>
    dictionary(value.objectAtIndex(index)),
  )
}

function text(value: unknown): string {
  return String(value)
}

function flag(value: unknown): boolean {
  if (value === null || value === undefined || value === NSNull.null()) return false
  if (value === true || value === false) return value
  if (value instanceof NSNumber) return value.boolValue
  return false
}

async function hasPendingRecovery(root: string): Promise<boolean> {
  const library = nativeIO.canonical(knownFolders.ios.library().path)
  const canonicalRoot = nativeIO.canonical(root)
  const [current, legacy] = recoveryDirectories(library, canonicalRoot)
  const found: string[][] = []
  for (const directory of [current, legacy]) {
    const kind = nativeIO.kind(directory)
    if (kind === null) {
      found.push([])
      continue
    }
    if (kind !== 'directory') throw new Error('Unsafe working-copy recovery namespace')
    if (nativeIO.canonical(directory) !== directory)
      throw new Error('Unsafe working-copy recovery namespace')
    const names = nativeIO.names(directory)
    const artifacts = directory === legacy ? names.filter((name) => name !== 'artifacts') : names
    for (const name of artifacts) {
      if (name === '.' || name === '..' || name.includes('/'))
        throw new Error('Unsafe recovery entry')
      const entry = `${directory}/${name}`
      const entryKind = nativeIO.kind(entry)
      if (directory === legacy && /^[0-9a-f]{1,64}$/.test(name) && entryKind === 'directory')
        continue
      if (entryKind !== 'regular') throw new Error('Unsafe recovery entry')
    }
    found.push(artifacts)
  }
  return recoveryArtifactNames(found[0] ?? [], found[1] ?? []).length > 0
}

function statusRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    path: row.path === NSNull.null() ? '' : text(row.path),
    staged: flag(row.staged),
    worktree: flag(row.worktree),
    conflict: flag(row.conflict),
  }))
}

/** iOS implementation of the semantic working-copy interface. */
export const nativeWorkingCopy: NativeWorkingCopy = {
  async canonicalRoot(root) {
    const value = checked((error) => HoliNativeGit.alloc().init().canonicalRootError(root, error))
    if (!value) throw new Error('Native Git returned no canonical root')
    return String(value)
  },
  async identity(root) {
    const value = checked((error) =>
      HoliNativeGit.alloc().init().workingCopyIdentityError(root, error),
    )
    if (!value) throw new Error('Native Git returned no working-copy identity')
    const result = dictionary(value)
    const remotes = result.remotes as NSArray<NSObject> | undefined
    return {
      remotes: remotes
        ? Array.from({ length: Number(remotes.count) }, (_, index) =>
            String(remotes.objectAtIndex(index)),
          )
        : [],
      branch: result.branch === NSNull.null() ? null : text(result.branch ?? '') || null,
      attached: flag(result.attached),
    }
  },
  async candidates(root) {
    const value = checked((error) =>
      HoliNativeGit.alloc().init().workingCopyCandidatesError(root, error),
    )
    if (!value) throw new Error('Native Git returned no working-copy candidates')
    return entries(value).map((row) => ({ path: text(row.path) }))
  },
  async authorize(root, path) {
    return checked((error) =>
      HoliNativeGit.alloc().init().authorizeWorkingCopyPathRootError(path, root, error),
    )
  },
  async recoveryPending(root) {
    return hasPendingRecovery(root)
  },
  async status(root, paths) {
    const nativePaths = NSMutableArray.alloc<string>().init()
    for (const path of paths) nativePaths.addObject(path)
    const value = checked((error) =>
      HoliNativeGit.alloc().init().workingCopyStatusRootError(nativePaths, root, error),
    )
    if (!value) throw new Error('Native Git returned no working-copy status')
    return statusRows(entries(value))
  },
}
