export type Entry = { path: string; kind: 'file' | 'directory' }

/** Native filesystem operations required by the portable vault store. */
export const storageCheckpoints = [
  'journal-before',
  'journal-after',
  'file-before',
  'file-after',
  'cleanup-before',
  'cleanup-after',
] as const
export type StorageCheckpoint = (typeof storageCheckpoints)[number]
export type StorageCheckpointCallback = (event: {
  phase: StorageCheckpoint
  direction: 'before' | 'after'
  operationId: string
  path?: string
}) => Promise<void>

export interface NativeFiles {
  canonicalRoot(root: string): Promise<string>
  list(root: string): Promise<Entry[]>
  read(root: string, relativePath: string): Promise<Uint8Array>
  readOptional(root: string, relativePath: string): Promise<Uint8Array | null>
  publish(
    root: string,
    relativePath: string,
    bytes: Uint8Array,
    expected: Uint8Array | null,
  ): Promise<void>
  create(root: string, relativePath: string, bytes: Uint8Array): Promise<void>
  privateList(root: string): Promise<string[]>
  privateRead(root: string, name: string): Promise<Uint8Array>
  privatePublish(
    root: string,
    name: string,
    bytes: Uint8Array,
    expected: Uint8Array | null,
  ): Promise<void>
  privateRemove(root: string, name: string, expected: Uint8Array): Promise<void>
  remove(root: string, relativePath: string, expected: Uint8Array): Promise<void>
}
