/** Holi's types for the parts of zip.js it uses itself (../vendored.md). */
export interface Entry {
  filename: string
  directory: boolean
  uncompressedSize: number
}

export class BlobReader {
  constructor(blob: Blob)
}

export class ZipReader {
  constructor(reader: BlobReader)
  getEntries(): Promise<Entry[]>
  close(): Promise<void>
}

export function configure(options: { useWebWorkers?: boolean }): void
