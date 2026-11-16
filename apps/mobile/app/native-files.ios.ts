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
      if (!siblings || !Array.from(siblings).includes(piece)) throw new Error('Case alias rejected')
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
      const error = new interop.Reference<NSError>()
      const names = NSFileManager.defaultManager.contentsOfDirectoryAtPathError(directory, error)
      checkError(error)
      for (const name of Array.from(names ?? [])) {
        const rel = prefix ? `${prefix}/${name}` : name
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
    return toBytes(readData(checkedPath(root, relative)))
  },
  async create(root, relative, bytes) {
    const target = checkedPath(root, relative, true)
    const manager = NSFileManager.defaultManager
    if (manager.fileExistsAtPath(target)) throw new Error('Destination already exists')
    // createFileAtPath is checked and never reports a false success; the store serializes in-process.
    if (!manager.createFileAtPathContentsAttributes(target, toData(bytes), null))
      throw new Error('Exclusive file creation failed')
    const handle = NSFileHandle.fileHandleForWritingAtPath(target)
    if (!handle) throw new Error('Could not synchronize created file')
    handle.synchronizeFile()
    handle.closeFile()
  },
  async publish(root, relative, bytes, expected) {
    const target = checkedPath(root, relative)
    const before = toBytes(readData(target))
    if (
      expected &&
      (before.length !== expected.length || before.some((byte, index) => byte !== expected[index]))
    )
      throw new Error('Stale bytes')
    const error = new interop.Reference<NSError>()
    const ok = toData(bytes).writeToURLOptionsError(
      NSURL.fileURLWithPath(target),
      1 as NSDataWritingOptions,
      error,
    )
    checkError(error)
    if (!ok) throw new Error('Atomic Foundation replacement failed')
    const handle = NSFileHandle.fileHandleForWritingAtPath(target)
    if (!handle) throw new Error('Could not synchronize replacement')
    handle.synchronizeFile()
    handle.closeFile()
  },
}
