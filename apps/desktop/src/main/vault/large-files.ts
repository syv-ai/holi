/**
 * The large-file gate (docs/specs/2026-08-03-large-binary-policy-design.md).
 *
 * Git history is permanent and replicated to every clone, and push is automatic
 * (D61) — so a big binary committed once is published to everyone before anyone
 * reacts, forever. This module keeps oversized files out: `partitionBySize` is
 * the pure decision the autosave loop uses to hold them back, and the pre-commit
 * hook (below) is the same gate for the agent's own direct commits.
 */

/** The default cap when `.holi/settings.json` sets no `maxCommittedFileBytes`.
 *  10 MB: notes-vault assets (images, PDFs) sit well under; this catches videos,
 *  datasets, exported binaries. (GitHub warns at 50 / blocks at 100 MB.) */
export const DEFAULT_MAX_COMMITTED_FILE_BYTES = 10 * 1024 * 1024

export interface HeldBackFile {
  path: string
  bytes: number
}

/**
 * Split dirty paths into what to commit vs what to hold back. `sizeOf` returns
 * the working-tree byte size, or `null` for a path with no file — a deletion,
 * which always commits (it shrinks history). Only a file strictly over the
 * threshold is held back. Pure: the async stat happens in the caller.
 */
export function partitionBySize(
  dirtyPaths: string[],
  sizeOf: (path: string) => number | null,
  threshold: number,
): { commit: string[]; heldBack: HeldBackFile[] } {
  const commit: string[] = []
  const heldBack: HeldBackFile[] = []
  for (const path of dirtyPaths) {
    const bytes = sizeOf(path)
    if (bytes !== null && bytes > threshold) {
      heldBack.push({ path, bytes })
    } else {
      commit.push(path)
    }
  }
  return { commit, heldBack }
}
