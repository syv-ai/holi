import { knownFolders } from '@nativescript/core'
import { isInIgnoredDir, isLocalOnlyPath, isSecretPath } from '@holi/shared/mobile-path-safety'
import { nativeIO } from './native-posix.ios'
import { stagingDirectory, stageNamePattern } from './storage-staging'
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
    if (
      createParents &&
      names.some((entry) => entry !== name && collisionKey(entry) === collisionKey(name))
    )
      throw new Error('Filesystem spelling collision')
    const next = `${current}/${name}`
    const kind = nativeIO.kind(next)
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
  directory(stageRoot)
  const target = stagingDirectory(library, root)
  for (const segment of target.slice(stageRoot.length + 1).split('/')) {
    stageRoot += `/${segment}`
    directory(stageRoot)
  }
  return stageRoot
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
    async create(root, relative, bytes) {
      await publish(root, relative, bytes, null)
    },
    async publish(root, relative, bytes, expected) {
      await publish(root, relative, bytes, expected)
    },
  }
}

export const nativeFiles = createNativeFiles()
