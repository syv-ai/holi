import type { NativeWorkingCopy } from './working-copy'

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
  return Array.from({ length: Number(value.count) }, (_, index) => dictionary(value.objectAtIndex(index)))
}

function text(value: unknown): string {
  return String(value)
}

function flag(value: unknown): boolean {
  return Boolean(value)
}

function statusRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    path: text(row.path),
    staged: flag(row.staged),
    worktree: flag(row.worktree),
    conflict: flag(row.conflict),
  }))
}

/** iOS implementation of the semantic working-copy interface. */
export const nativeWorkingCopy: NativeWorkingCopy = {
  canonicalRoot(root) {
    const value = checked((error) => HoliNativeGit.alloc().init().canonicalRootError(root, error))
    if (!value) throw new Error('Native Git returned no canonical root')
    return String(value)
  },
  identity(root) {
    const value = checked((error) => HoliNativeGit.alloc().init().workingCopyIdentityError(root, error))
    if (!value) throw new Error('Native Git returned no working-copy identity')
    const result = dictionary(value)
    const remotes = result.remotes as NSArray<NSObject> | undefined
    return {
      remotes: remotes ? Array.from({ length: Number(remotes.count) }, (_, index) => String(remotes.objectAtIndex(index))) : [],
      branch: text(result.branch ?? '') || null,
      attached: flag(result.attached),
    }
  },
  candidates(root) {
    const value = checked((error) => HoliNativeGit.alloc().init().workingCopyCandidatesError(root, error))
    if (!value) throw new Error('Native Git returned no working-copy candidates')
    return entries(value).map((row) => ({ path: text(row.path) }))
  },
  authorize(root, path) {
    return checked((error) => HoliNativeGit.alloc().init().authorizeWorkingCopyPathRootError(path, root, error))
  },
  hasPendingRecovery(root) {
    return checked((error) => HoliNativeGit.alloc().init().hasPendingRecoveryError(root, error))
  },
  status(root, paths) {
    const nativePaths = NSArray.fromArray(paths)
    const value = checked((error) => HoliNativeGit.alloc().init().workingCopyStatusRootError(nativePaths, root, error))
    if (!value) throw new Error('Native Git returned no working-copy status')
    return statusRows(entries(value))
  },
}
