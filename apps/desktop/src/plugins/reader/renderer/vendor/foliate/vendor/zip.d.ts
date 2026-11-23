/** Holi's types for the parts of zip.js it uses itself (../vendored.md). */
export interface Entry {
  getData(writer: WritableStream<Uint8Array>): Promise<unknown>
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
