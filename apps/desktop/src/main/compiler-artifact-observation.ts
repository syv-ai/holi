import { opendirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type CompilerArtifactObservation = {
  files: Record<string, { count: number; bytes: number }>
  entriesRead: number
  limitReached: boolean
  metadataErrors: number
  oversized: number
  capped: number
  scanFailed: boolean
}

type FileSystem = {
  openDirectory(path: string): { read(): { name: string } | null; close(): void }
  stat(path: string): { isFile(): boolean; size: number }
}

const realFileSystem: FileSystem = {
  openDirectory: (path) => {
    const directory = opendirSync(path, { bufferSize: 16 })
    return { read: () => directory.readSync(), close: () => directory.closeSync() }
  },
  stat: (path) => statSync(path),
}

export function observeCompilerArtifacts(
  directory: string,
  fileSystem: FileSystem = realFileSystem,
): CompilerArtifactObservation {
  const result: CompilerArtifactObservation = {
    files: {},
    entriesRead: 0,
    limitReached: false,
    metadataErrors: 0,
    oversized: 0,
    capped: 0,
    scanFailed: false,
  }
  let handle: ReturnType<FileSystem['openDirectory']> | undefined
  try {
    handle = fileSystem.openDirectory(directory)
    while (result.entriesRead < 64) {
      const entry = handle.read()
      if (!entry) break
      result.entriesRead++
      const extension = /\.(cs|dll|pdb|rsp)$/i.exec(entry.name)?.[1]?.toLowerCase()
      if (!extension) continue
      try {
        const metadata = fileSystem.stat(join(directory, entry.name))
        if (!metadata.isFile()) continue
        if (metadata.size > 16 * 1024 * 1024) {
          result.oversized++
          continue
        }
        const total = result.files[extension] ?? { count: 0, bytes: 0 }
        if (total.count === 16) {
          result.capped++
          continue
        }
        total.count++
        total.bytes += metadata.size
        result.files[extension] = total
      } catch {
        result.metadataErrors++
      }
    }
    result.limitReached = result.entriesRead === 64
  } catch {
    result.scanFailed = true
  } finally {
    try {
      handle?.close()
    } catch {
      result.scanFailed = true
    }
  }
  return result
}
