import { isInIgnoredDir, isLocalOnlyPath, isSecretPath } from '@holi/shared/mobile-path-safety'
import type { Entry, NativeFiles } from './native-files'

function checkError(error: interop.Reference<NSError>): void {
  if (error.value) throw new Error(error.value.localizedDescription)
}
function filePath(root: string, relative: string): string {
  if (
    !root.startsWith('/') ||
    relative
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.includes('\\'))
  ) {
    throw new Error('Invalid native path')
  }
  const normalized = NSString.stringWithString(`${root}/${relative}`).stringByStandardizingPath
  if (!normalized.startsWith(`${root}/`)) throw new Error('Path escaped the vault')
  return normalized
}
function attrs(path: string): NSDictionary<string, unknown> | null {
  const error = new interop.Reference<NSError>()
  const value = NSFileManager.defaultManager.attributesOfItemAtPathError(path, error)
  if (error.value && error.value.code !== 260 && error.value.code !== 2) checkError(error)
  return value
}
function checkedPath(
  root: string,
  relative: string,
  allowMissing = false,
  allowDirectory = false,
): string {
  let current = root
  const pieces = relative.split('/')
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index]
    // iOS exposes canonical filenames in NFD; reject aliases before Foundation resolves them.
    if (piece !== piece?.normalize('NFD')) throw new Error('Filesystem spelling alias rejected')
    current = `${current}/${piece}`
    const info = attrs(current)
    if (!info) {
      if (!allowMissing) throw new Error('File does not exist')
      if (index < pieces.length - 1) {
        const error = new interop.Reference<NSError>()
        const made =
          NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(
            current,
            false,
            null,
            error,
          )
        checkError(error)
        if (!made) throw new Error('Could not create parent directory')
      }
      continue
    }
    const type = info.objectForKey(NSFileType)
    if (type === NSFileTypeSymbolicLink) throw new Error('Symbolic link rejected')
    const directory = type === NSFileTypeDirectory
    if (index < pieces.length - 1 && !directory) throw new Error('File ancestor collision')
    if (index === pieces.length - 1 && directory && !allowDirectory)
      throw new Error('Directory collision')
    {
      const error = new interop.Reference<NSError>()
      const parent = index === 0 ? root : current.substring(0, current.lastIndexOf('/'))
      const siblings = NSFileManager.defaultManager.contentsOfDirectoryAtPathError(parent, error)
      checkError(error)
      if (!siblings || !Array.from(siblings).some((name) => String(name) === piece))
        throw new Error('Case alias rejected')
    }
  }
  return filePath(root, relative)
}
function toBytes(data: NSData): Uint8Array {
  return new Uint8Array(interop.bufferFromData(data))
}
function toData(bytes: Uint8Array): NSData {
  return NSData.dataWithBytesLength(bytes, bytes.length)
}
function readData(path: string): NSData {
  const error = new interop.Reference<NSError>()
  const data = NSData.dataWithContentsOfURLOptionsError(
    NSURL.fileURLWithPath(path),
    0 as NSDataReadingOptions,
    error,
  )
  checkError(error)
  if (!data) throw new Error('Foundation returned no file data')
  return data
}
function syncAndClose(path: string): void {
  const handle = NSFileHandle.fileHandleForWritingAtPath(path)
  if (!handle) throw new Error('Could not open staged file')
  let failure: unknown
  try {
    const error = new interop.Reference<NSError>()
    if (!handle.synchronizeAndReturnError(error)) checkError(error)
    checkError(error)
  } catch (error) {
    failure = error
  }
  try {
    const error = new interop.Reference<NSError>()
    if (!handle.closeAndReturnError(error)) checkError(error)
    checkError(error)
  } catch (error) {
    failure ??= error
  }
  if (failure) throw failure
}
function removeOwned(path: string): void {
  const error = new interop.Reference<NSError>()
  if (!NSFileManager.defaultManager.removeItemAtPathError(path, error)) checkError(error)
  checkError(error)
}
function ownershipPath(staging: string): string {
  return `${staging}.owner`
}
function acquireStageOwnership(staging: string): void {
  const marker = ownershipPath(staging)
  const name = staging.substring(staging.lastIndexOf('/') + 1)
  const data = NSString.stringWithString(name).dataUsingEncoding(NSUTF8StringEncoding)
  if (!data) throw new Error('Could not encode staging ownership')
  if (!NSFileManager.defaultManager.createFileAtPathContentsAttributes(marker, data, null))
    throw new Error('Could not acquire staging ownership')
  syncAndClose(marker)
}
function recoverOwnedStages(directory: string): void {
  const error = new interop.Reference<NSError>()
  const names = NSFileManager.defaultManager.contentsOfDirectoryAtPathError(directory, error)
  checkError(error)
  for (const name of Array.from(names ?? [])) {
    if (!name.startsWith('.holi-storage-stage-') || !name.endsWith('.tmp.owner')) continue
    const marker = `${directory}/${name}`
    const stageNameValue = NSString.stringWithContentsOfFileEncodingError(
      marker,
      NSUTF8StringEncoding,
      error,
    )
    checkError(error)
    const stageName = stageNameValue?.toString()
    if (!stageName || !/^\.holi-storage-stage-[A-F0-9-]+\.tmp$/.test(stageName)) continue
    const stage = `${directory}/${stageName}`
    const info = attrs(stage)
    if (info?.objectForKey(NSFileType) === NSFileTypeRegular) removeOwned(stage)
    removeOwned(marker)
  }
}
async function stagedCheckpoint(stagePath: string): Promise<void> {
  const marker = NSProcessInfo.processInfo.environment.objectForKey(
    'HOLI_STORAGE_STAGED_CHECKPOINT',
  ) as string | undefined
  if (!marker) return
  const data = NSString.stringWithString(stagePath).dataUsingEncoding(NSUTF8StringEncoding)
  if (!data) throw new Error('Could not encode staged checkpoint')
  const error = new interop.Reference<NSError>()
  if (!data.writeToFileOptionsError(marker, 1, error)) checkError(error)
  checkError(error)
  while (NSFileManager.defaultManager.fileExistsAtPath(marker))
    await new Promise((resolve) => setTimeout(resolve, 25))
}

/** Foundation-backed filesystem adapter. Failed native results are never treated as success. */
export const nativeFiles: NativeFiles = {
  async canonicalRoot(root) {
    const url = NSURL.fileURLWithPathIsDirectory(root, true)
    if (!url) throw new Error('Invalid vault URL')
    const standardized = url.URLByStandardizingPath
    if (!standardized) throw new Error('Could not standardize vault URL')
    const canonical = standardized.URLByResolvingSymlinksInPath
    if (
      !canonical ||
      !canonical.path ||
      !NSFileManager.defaultManager.fileExistsAtPath(canonical.path)
    )
      throw new Error('Vault root is unavailable')
    const info = attrs(canonical.path)
    if (info?.objectForKey(NSFileType) !== NSFileTypeDirectory)
      throw new Error('Vault root is not a directory')
    return canonical.path
  },
  async list(root) {
    const result: Entry[] = []
    const walk = (directory: string, prefix: string) => {
      recoverOwnedStages(directory)
      const error = new interop.Reference<NSError>()
      const names = NSFileManager.defaultManager.contentsOfDirectoryAtPathError(directory, error)
      checkError(error)
      for (const name of Array.from(names ?? [])) {
        const rel = prefix ? `${prefix}/${name}` : name
        // Excluded directories are pruned before metadata reads or recursion.
        if (isInIgnoredDir(rel) || isLocalOnlyPath(rel) || isSecretPath(rel)) continue
        if (rel.split('/').some((part: string) => part.startsWith('.holi-storage-'))) continue
        const unchecked = `${directory}/${name}`
        if (attrs(unchecked)?.objectForKey(NSFileType) === NSFileTypeSymbolicLink) continue
        const target = checkedPath(root, rel, false, true)
        const kind = attrs(target)?.objectForKey(NSFileType)
        if (kind === NSFileTypeDirectory) {
          result.push({ path: rel, kind: 'directory' })
          walk(target, rel)
        } else if (kind === NSFileTypeRegular) result.push({ path: rel, kind: 'file' })
      }
    }
    walk(root, '')
    return result
  },
  async read(root, relative) {
    const target = checkedPath(root, relative)
    recoverOwnedStages(target.substring(0, target.lastIndexOf('/')))
    return toBytes(readData(target))
  },
  async create(root, relative, bytes) {
    const target = checkedPath(root, relative, true)
    const directory = target.substring(0, target.lastIndexOf('/'))
    recoverOwnedStages(directory)
    const staging = `${directory}/.holi-storage-stage-${NSUUID.UUID().UUIDString}.tmp`
    const manager = NSFileManager.defaultManager
    let stageOwned = false
    let ownerOwned = false
    try {
      if (!manager.createFileAtPathContentsAttributes(staging, toData(bytes), null))
        throw new Error('Exclusive staging creation failed')
      stageOwned = true
      acquireStageOwnership(staging)
      ownerOwned = true
      syncAndClose(staging)
      const error = new interop.Reference<NSError>()
      if (!manager.moveItemAtPathToPathError(staging, target, error)) checkError(error)
      checkError(error)
      stageOwned = false
      removeOwned(ownershipPath(staging))
      ownerOwned = false
    } finally {
      if (stageOwned) removeOwned(staging)
      if (ownerOwned) removeOwned(ownershipPath(staging))
    }
  },
  async publish(root, relative, bytes, expected) {
    const target = checkedPath(root, relative)
    const before = toBytes(readData(target))
    if (
      expected &&
      (before.length !== expected.length || before.some((byte, index) => byte !== expected[index]))
    )
      throw new Error('Stale bytes')
    const directory = target.substring(0, target.lastIndexOf('/'))
    recoverOwnedStages(directory)
    const staging = `${directory}/.holi-storage-stage-${NSUUID.UUID().UUIDString}.tmp`
    const manager = NSFileManager.defaultManager
    let stageOwned = false
    let ownerOwned = false
    try {
      if (!manager.createFileAtPathContentsAttributes(staging, toData(bytes), null))
        throw new Error('Could not create owned staging file')
      stageOwned = true
      acquireStageOwnership(staging)
      ownerOwned = true
      syncAndClose(staging)
      await stagedCheckpoint(staging)
      const error = new interop.Reference<NSError>()
      const replaced =
        manager.replaceItemAtURLWithItemAtURLBackupItemNameOptionsResultingItemURLError(
          NSURL.fileURLWithPath(target),
          NSURL.fileURLWithPath(staging),
          null,
          0 as NSFileManagerItemReplacementOptions,
          null,
          error,
        )
      checkError(error)
      if (!replaced) throw new Error('Atomic staging publish failed')
      stageOwned = false
      removeOwned(ownershipPath(staging))
      ownerOwned = false
    } finally {
      if (stageOwned) removeOwned(staging)
      if (ownerOwned) removeOwned(ownershipPath(staging))
    }
  },
}
