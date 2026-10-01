/**
 * The file changed underneath the editor. Now what?
 *
 * The editor's own save needs no attribution: `base` is the text last loaded
 * or saved, advanced before the watcher reports the write, so the echo arrives
 * as `disk === base`. The snapshot push carries no path anyway.
 *
 * Rejected, because they race: path + mtime bookkeeping (two writes in one
 * tick), and pausing the watcher across the write (a late event reads as
 * foreign). Content comparison holds no timing assumption.
 * See docs/features/editor.md.
 */
import { merge3, normalizeText, type ConflictRegion, type Normalizer } from '@holi/shared'

export type Reload =
  /** Nothing happened that concerns this editor. */
  | { kind: 'none' }
  /** Clean buffer: take what is on disk, silently. */
  | { kind: 'reload'; text: string }
  /** Dirty buffer, and the two edits did not overlap. */
  | { kind: 'merged'; text: string }
  /** Not a foreign edit at all: Holi's own commit-time tidy. `base` moves to
   *  what is on disk and the buffer is left exactly as it is. */
  | { kind: 'rebase'; text: string }
  /** Dirty buffer, and they did. Surfaced, never silently resolved. */
  | { kind: 'conflict'; regions: ConflictRegion[] }

/**
 * The two ways out of a conflict, handed up with it. Closures, because only
 * the editor holds both texts that disagreed.
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
  normalizers: readonly Normalizer[],
): Reload {
  // Our own save echoing back, or a push about some other file.
  if (disk === base) return { kind: 'none' }

  // Holi's commit-time tidy (`normalize-md`, pre-commit), which rewrites the
  // file after `base` advanced. Keeping the buffer is safe because the tidy is
  // idempotent and reapplied next commit. Scoped to normalization alone:
  // `relink` rewrites carry real content, and dropping one would undo a rename.
  // Before the clean-buffer check, and for a clean buffer too: the commit
  // lands seconds after autosave, while someone who stopped to think is
  // looking at the line, and taking the tidied bytes would pull the space
  // they just typed out from under the caret. `hasNewText` then keeps the
  // untidied buffer from being written back.
  if (disk === normalizeText(base, path, normalizers)) return { kind: 'rebase', text: disk }

  // Clean buffer: nothing to lose. The common case, since autosave fires on
  // idle.
  if (buffer === base) return { kind: 'reload', text: disk }

  const merged = merge3(base, buffer, disk)
  return merged.kind === 'merged'
    ? { kind: 'merged', text: merged.text }
    : { kind: 'conflict', regions: merged.regions }
}

/**
 * Whether the buffer holds anything `base` does not, the commit-time tidy
 * aside. A buffer that differs only by what the tidy strips has nothing to
 * save: writing it would just be tidied again, and after a `rebase` it is the
 * normal state of an editor whose file was tidied under it.
 */
export function hasNewText(
  base: string,
  buffer: string,
  path: string,
  normalizers: readonly Normalizer[],
): boolean {
  if (buffer === base) return false
  // The hook tidies markdown only; in a `.env` a trailing space is content.
  if (!path.endsWith('.md')) return true
  return normalizeText(buffer, path, normalizers) !== normalizeText(base, path, normalizers)
}

/**
 * The single contiguous change that turns `current` into `target`: the span
 * between their common prefix and common suffix. `null` when they are equal.
 *
 * Coarse but always correct. For a `merged` reload the span is the foreign
 * edit, so CodeMirror's selection mapping preserves the caret. Returns a
 * `ChangeSpec` shape without depending on CodeMirror.
 */
export function minimalChange(
  current: string,
  target: string,
): { from: number; to: number; insert: string } | null {
  if (current === target) return null
  const maxPrefix = Math.min(current.length, target.length)
  let prefix = 0
  while (prefix < maxPrefix && current[prefix] === target[prefix]) prefix++
  // Cap the suffix at the prefix, or "aaa" -> "aa" double-counts the run.
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
