export type Entry = { path: string; kind: 'file' | 'directory' }

/** Native filesystem operations required by the portable vault store. */
export interface NativeFiles {
  canonicalRoot(root: string): Promise<string>
  list(root: string): Promise<Entry[]>
  read(root: string, relativePath: string): Promise<Uint8Array>
  publish(
    root: string,
    relativePath: string,
    bytes: Uint8Array,
    expected: Uint8Array | null,
  ): Promise<void>
  create(root: string, relativePath: string, bytes: Uint8Array): Promise<void>
}
