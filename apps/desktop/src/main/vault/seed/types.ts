/**
 * What one part of Holi (core, the agent, a plugin) seeds into a vault.
 *
 * Three kinds of file, each with its own rule (see `seed.ts`):
 *
 *   - **once**: created if absent, then the vault's forever.
 *   - **shipped**: written when the vault is created, and refreshed only by
 *     `holi skills update` (`update.ts`), which 3-way merges, so they are text.
 *   - **merged**: one contribution owns the file and says how to merge what
 *     the vault already has with what Holi needs (`merge`). Any contribution,
 *     the owner included, adds to it with `fragments`, in the owner's shape.
 */
export interface SeedContribution {
  /** Who contributes, for errors: `core`, `agent`, `pdf`. */
  id: string
  /** Vault path to content. Bytes for a binary such as a font. */
  once: Record<string, string | Uint8Array>
  /** Vault path to text. */
  shipped: Record<string, string>
  /**
   * What this contribution adds to merged files, by vault path: one entry
   * per concern, in the shape the file's owner reads. A fragment for a file
   * no contribution merges is ignored.
   */
  fragments?: Record<string, readonly unknown[]>
  /**
   * The files this contribution owns and merges: vault path to a function
   * from the text on disk (`null` when absent) and every contribution's
   * fragments for it, in list order, to the text to write, or `null` when
   * there is nothing to write.
   *
   * `has` answers whether a vault path exists, or is about to be written by
   * this same run, so a merge can refer only to files that are there.
   */
  merge?: Record<string, MergeFile>
}

export type MergeFile = (
  existing: string | null,
  fragments: readonly unknown[],
  has: (rel: string) => Promise<boolean>,
) => Promise<string | null>

/** What one run of `ensureSeeded` wrote. */
export interface SeedResult {
  written: string[]
}
