import { knownFolders } from '@nativescript/core'
import { isInIgnoredDir, isLocalOnlyPath, isSecretPath } from '@holi/shared/mobile-path-safety'
import { nativeIO } from './native-posix.ios'
import { legacyStagingDirectory, stagingDirectory, stageNamePattern } from './storage-staging'
import type { Entry, NativeFiles } from './native-files'

type Fault = 'stage-open' | 'stage-write' | 'stage-sync' | 'stage-close' | 'publish'
interface NativeOptions {
  fault?: Fault
  staged?: (event: { root: string; relative: string; stage: string }) => Promise<void>
}

function directory(path: string): void {
  const kind = nativeIO.kind(path)
  if (kind === null) nativeIO.mkdir(path)
  else if (kind !== 'directory') throw new Error('Directory collision or symlink')
}

function checkedPath(root: string, relative: string, createParents = false): string {
  const pieces = relative.split('/')
  if (
    pieces.some(
      (part) =>
        !part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0'),
    )
  )
    throw new Error('Invalid native path')
  let current = root
  for (let index = 0; index < pieces.length; index++) {
    const name = pieces[index] ?? ''
    const names = nativeIO.names(current)
    const collisionKey = (value: string) =>
      String(NSString.stringWithString(value).precomposedStringWithCanonicalMapping).toLowerCase()
    const next = `${current}/${name}`
    const kind = nativeIO.kind(next)
    if (
      (createParents || kind === null) &&
      names.some((entry) => entry !== name && collisionKey(entry) === collisionKey(name))
    )
      throw new Error('Filesystem spelling collision')
    if (kind !== null && !names.includes(name))
      throw new Error('Filesystem spelling alias rejected')
    if (kind === 'symlink' || kind === 'other') throw new Error('Unsupported filesystem entry')
    if (index < pieces.length - 1) {
      if (kind === null && createParents) nativeIO.mkdir(next)
      else if (kind !== 'directory') throw new Error('Missing or non-directory ancestor')
    } else if (kind === 'directory') throw new Error('Directory collision')
    current = next
  }
  return current
}

function excluded(path: string): boolean {
  return (
    isInIgnoredDir(path) ||
    isLocalOnlyPath(path) ||
    isSecretPath(path) ||
    path.split('/').some((name) => name.startsWith('.holi-storage-'))
  )
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

/** Trusted staging is outside vault content, namespaced by the exact canonical root bytes. */
function privateStages(root: string): string {
  const library = nativeIO.canonical(knownFolders.ios.library().path)
  let stageRoot = `${library}/HoliVaultStorage`
  if (stageRoot === root || stageRoot.startsWith(`${root}/`) || root.startsWith(`${stageRoot}/`))
    throw new Error('Vault overlaps private storage')
  const rootParent = stageRoot.slice(0, stageRoot.lastIndexOf('/'))
  directory(stageRoot)
  nativeIO.syncDirectory(rootParent)
  nativeIO.syncDirectory(stageRoot)
  const target = stagingDirectory(library, root)
  for (const segment of target.slice(stageRoot.length + 1).split('/')) {
    const parent = stageRoot
    stageRoot += `/${segment}`
    directory(stageRoot)
    // Confirm even pre-existing directories: a prior mkdir may have outlived a
    // failed parent fsync, so existence alone is not a durability guarantee.
    nativeIO.syncDirectory(parent)
    nativeIO.syncDirectory(stageRoot)
  }
  migrateLegacyArtifacts(legacyStagingDirectory(library, root), stageRoot)
  return stageRoot
}

/** Move only direct, recognized legacy artifacts; unknown entries (including sibling-root
 * hex directories) remain untouched. A conflicting destination refuses recovery. */
function migrateLegacyArtifacts(legacy: string, target: string): void {
  if (legacy === target || nativeIO.kind(legacy) !== 'directory') return
  for (const name of nativeIO.names(legacy)) {
    if (!stageNamePattern.test(name) && !/^move-[0-9a-f-]+\.json$/i.test(name)) continue
    const source = `${legacy}/${name}`
    if (nativeIO.kind(source) !== 'regular') throw new Error('Invalid legacy private artifact')
    const destination = `${target}/${name}`
    const targetKind = nativeIO.kind(destination)
    const bytes = nativeIO.read(source)
    if (targetKind === null) {
      const temporary = `${target}/stage-${NSUUID.UUID().UUIDString}.tmp`
      nativeIO.writeExclusive(temporary, bytes)
      nativeIO.publish(temporary, destination, true)
    } else if (targetKind !== 'regular' || !equal(nativeIO.read(destination), bytes)) {
      throw new Error('Conflicting legacy private artifact')
    }
    nativeIO.syncFile(destination)
    nativeIO.syncDirectory(target)
    nativeIO.removeFile(source)
    nativeIO.syncDirectory(legacy)
  }
}

/** The store serializes operations per canonical root, including first-use recovery. */
export function createNativeFiles(options: NativeOptions = {}): NativeFiles {
  const recovered = new Map<string, string>()
  const stages = (root: string): string => {
    const previous = recovered.get(root)
    if (previous) return previous
    const path = privateStages(root)
    for (const name of nativeIO.names(path)) {
      if (!stageNamePattern.test(name)) continue
      const candidate = `${path}/${name}`
      if (nativeIO.kind(candidate) === 'regular') nativeIO.removeFile(candidate)
    }
    recovered.set(root, path)
    return path
  }
  const publish = async (
    root: string,
    relative: string,
    bytes: Uint8Array,
    expected: Uint8Array | null,
  ) => {
    const target = checkedPath(root, relative, expected === null)
    if (expected !== null && !equal(nativeIO.read(target), expected)) throw new Error('Stale bytes')
    const stage = `${stages(root)}/stage-${NSUUID.UUID().UUIDString}.tmp`
    let owned = false
    try {
      nativeIO.writeExclusive(stage, bytes, options.fault)
      owned = true
      await options.staged?.({ root, relative, stage })
      if (expected !== null && !equal(nativeIO.read(checkedPath(root, relative)), expected))
        throw new Error('Changed during save')
      nativeIO.publish(stage, target, expected === null, options.fault)
      owned = false
    } finally {
      if (owned && nativeIO.kind(stage) === 'regular') nativeIO.removeFile(stage)
    }
  }
  return {
    operationId: () => NSUUID.UUID().UUIDString.toLowerCase(),
    async canonicalRoot(root) {
      return nativeIO.canonical(root)
    },
    async list(root) {
      stages(root)
      const result: Entry[] = []
      const walk = (path: string, prefix: string) => {
        for (const name of nativeIO.names(path)) {
          const relative = prefix ? `${prefix}/${name}` : name
          if (excluded(relative)) continue
          const absolute = `${path}/${name}`
          const kind = nativeIO.kind(absolute)
          if (kind === 'directory') {
            result.push({ path: relative, kind: 'directory' })
            walk(absolute, relative)
          } else if (kind === 'regular') result.push({ path: relative, kind: 'file' })
        }
      }
      walk(root, '')
      return result
    },
    async read(root, relative) {
      stages(root)
      return nativeIO.read(checkedPath(root, relative))
    },
    async readOptional(root, relative) {
      stages(root)
      const path = checkedPath(root, relative)
      return nativeIO.kind(path) === null ? null : nativeIO.read(path)
    },
    async confirm(root, relative, expected) {
      stages(root)
      const path = checkedPath(root, relative)
      const kind = nativeIO.kind(path)
      if (expected === null) {
        if (kind !== null) throw new Error('Unexpected move postimage')
      } else {
        if (kind !== 'regular' || !equal(nativeIO.read(path), expected))
          throw new Error('Unexpected move postimage')
        nativeIO.syncFile(path)
      }
      nativeIO.syncDirectory(path.slice(0, path.lastIndexOf('/')))
    },
    async create(root, relative, bytes) {
      await publish(root, relative, bytes, null)
    },
    async publish(root, relative, bytes, expected) {
      await publish(root, relative, bytes, expected)
    },
    async privateList(root) {
      const path = stages(root)
      // Reconfirm deletion durability even when this adapter already cached the namespace.
      // A prior unlink may have succeeded while this sync failed; absence is not yet durable.
      nativeIO.syncDirectory(path)
      return nativeIO.names(path).filter((name) => !stageNamePattern.test(name))
    },
    async privateRead(root, name) {
      if (!/^move-[0-9a-f-]+\.json$/i.test(name)) throw new Error('Invalid private artifact name')
      const path = `${stages(root)}/${name}`
      if (nativeIO.kind(path) !== 'regular') throw new Error('Invalid private journal file')
      return nativeIO.read(path)
    },
    async privatePublish(root, name, bytes, expected) {
      if (!/^move-[0-9a-f-]+\.json$/i.test(name)) throw new Error('Invalid private artifact name')
      const directoryPath = stages(root)
      const target = `${directoryPath}/${name}`
      const kind = nativeIO.kind(target)
      if (
        expected === null
          ? kind !== null
          : kind !== 'regular' || !equal(nativeIO.read(target), expected)
      )
        throw new Error('Stale private journal')
      const stage = `${directoryPath}/stage-${NSUUID.UUID().UUIDString}.tmp`
      nativeIO.writeExclusive(stage, bytes, options.fault)
      try {
        nativeIO.publish(stage, target, expected === null, options.fault)
      } catch (error) {
        if (nativeIO.kind(stage) === 'regular') nativeIO.removeFile(stage)
        throw error
      }
    },
    async privateConfirm(root, name, expected) {
      const target = `${stages(root)}/${name}`
      if (nativeIO.kind(target) !== 'regular' || !equal(nativeIO.read(target), expected))
        throw new Error('Stale private journal confirmation')
      nativeIO.syncFile(target)
      nativeIO.syncDirectory(target.slice(0, target.lastIndexOf('/')))
    },
    async privateRemove(root, name, expected) {
      const target = `${stages(root)}/${name}`
      if (nativeIO.kind(target) !== 'regular' || !equal(nativeIO.read(target), expected))
        throw new Error('Stale private journal removal')
      nativeIO.removeFile(target)
      nativeIO.syncDirectory(`${target.slice(0, target.lastIndexOf('/'))}`)
    },
    async remove(root, relative, expected) {
      const target = checkedPath(root, relative)
      if (!equal(nativeIO.read(target), expected)) throw new Error('Stale bytes')
      nativeIO.removeFile(target)
      nativeIO.syncDirectory(target.slice(0, target.lastIndexOf('/')))
    },
  }
}

export const nativeFiles = createNativeFiles()
