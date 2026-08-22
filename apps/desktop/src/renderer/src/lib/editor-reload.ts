/**
 * The file changed underneath the editor. Now what?
 *
 * **The editor's own save needs no attribution**, and that is the entire
 * design. `base` is the text the editor last loaded *or saved*; a save advances
 * it before the watcher can report the write, so by the time the change comes
 * back around `disk === base` and this returns `none`. Nothing has to ask "was
 * that me?", which matters because the snapshot push carries no path and could
 * not answer that question anyway.
 *
 * The three alternatives all race, and `notes-editor.md` §Risks names this as
 * the most likely bug in that PRD:
 *
 *   - **path + mtime bookkeeping** — two writes inside one mtime tick are
 *     indistinguishable, and a coalesced watcher event covers both.
 *   - **pausing the watcher across the write** — the event arrives after the
 *     unpause on a slow filesystem, and is then treated as foreign.
 *   - **content comparison** — cannot race, because it compares the only two
 *     things that matter and holds no timing assumption at all.
 *
 * This is `notes-editor.md` §External writes, first bullet.
 */
import { merge3, normalizeText, type ConflictRegion } from '@holi/shared'

export type Reload =
  /** Nothing happened that concerns this editor. */
  | { kind: 'none' }
  /** Clean buffer: take what is on disk, silently (FR-11). */
  | { kind: 'reload'; text: string }
  /** Dirty buffer, and the two edits did not overlap. */
  | { kind: 'merged'; text: string }
  /** Not a foreign edit at all: Holi's own commit-time tidy. `base` moves to
   *  what is on disk and the buffer is left exactly as it is. */
  | { kind: 'rebase'; text: string }
  /** Dirty buffer, and they did. Routed to the vault's reconcile affordance —
   *  a merger that silently picked a side would remove the feature. */
  | { kind: 'conflict'; regions: ConflictRegion[] }

/**
 * The two ways out of a conflict, handed up with it.
 *
 * They are closures rather than a path, because only the editor still holds
 * both texts that disagreed: the buffer lives in its `EditorView` and the
 * buffer registry is anonymous, so nothing above can reconstruct either side.
 */
export interface ConflictResolvers {
  /** Write the buffer over what is on disk. */
  keepMine: () => Promise<void>
  /** Drop the buffer and take the file as it stands. */
  takeDisk: () => void
}

export function decideReload(
  base: string,
  buffer: string,
  disk: string,
  path: string,
): Reload {
  // Whoever wrote it, the bytes now on disk are the bytes this editor last saw.
  // Includes the editor's own autosave, an agent write that produced identical
  // content, and every push about some *other* file.
  if (disk === base) return { kind: 'none' }

  // Clean buffer: there is nothing to lose. The common case by a wide margin,
  // because autosave fires on idle.
  if (buffer === base) return { kind: 'reload', text: disk }

  // Holi's own commit-time tidy, arriving after the save that triggered it.
  // `normalize-md` runs in the pre-commit hook, so it rewrites the file AFTER
  // `base` was advanced — the one write this module's invariant cannot see
  // coming, and the reason it is recognised here rather than attributed.
  //
  // Keeping the buffer is safe precisely because the tidy is idempotent and
  // re-derivable: the next commit applies it again to whatever is written next,
  // so nothing is lost by preferring what is being typed. That is also why this
  // is scoped to normalization alone — `relink` rewrites carry real content, and
  // dropping one in favour of the buffer would silently undo a rename.
  //
  // Ordered after the clean-buffer check on purpose: with nothing to protect,
  // taking the tidied bytes outright is simpler and leaves base === disk.
  if (disk === normalizeText(base, path)) return { kind: 'rebase', text: disk }

  const merged = merge3(base, buffer, disk)
  return merged.kind === 'merged'
    ? { kind: 'merged', text: merged.text }
    : { kind: 'conflict', regions: merged.regions }
}

/**
 * The single contiguous change that turns `current` into `target`: the span
 * between their common prefix and common suffix. `null` when they are equal.
 *
 * A one-span diff is coarser than a multi-hunk one, but it is always correct —
 * and for a `merged` reload the diff of the buffer against the merged text *is*
 * the foreign edit, so the changed span never covers the caret, and CodeMirror's
 * selection mapping preserves it for free. Framework-free on purpose: the return
 * is a CodeMirror `ChangeSpec` shape, but this module holds no view dependency.
 */
export function minimalChange(
  current: string,
  target: string,
): { from: number; to: number; insert: string } | null {
  if (current === target) return null
  const maxPrefix = Math.min(current.length, target.length)
  let prefix = 0
  while (prefix < maxPrefix && current[prefix] === target[prefix]) prefix++
  // Cap the suffix so it cannot reach back past the prefix in either string —
  // otherwise "aaa" -> "aa" would double-count the shared run.
  const maxSuffix = Math.min(current.length - prefix, target.length - prefix)
  let suffix = 0
  while (
    suffix < maxSuffix &&
    current[current.length - 1 - suffix] === target[target.length - 1 - suffix]
  ) {
    suffix++
  }
  return {
    from: prefix,
    to: current.length - suffix,
    insert: target.slice(prefix, target.length - suffix),
  }
}
