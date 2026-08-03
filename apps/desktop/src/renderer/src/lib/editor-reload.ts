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
 * That closes `notes-editor.md` §Open question 2.
 */
import { merge3, type ConflictRegion } from '@holi/shared'

export type Reload =
  /** Nothing happened that concerns this editor. */
  | { kind: 'none' }
  /** Clean buffer: take what is on disk, silently (FR-11). */
  | { kind: 'reload'; text: string }
  /** Dirty buffer, and the two edits did not overlap. */
  | { kind: 'merged'; text: string }
  /** Dirty buffer, and they did. Routed to the vault's reconcile affordance —
   *  a merger that silently picked a side would remove the feature. */
  | { kind: 'conflict'; regions: ConflictRegion[] }

export function decideReload(base: string, buffer: string, disk: string): Reload {
  // Whoever wrote it, the bytes now on disk are the bytes this editor last saw.
  // Includes the editor's own autosave, an agent write that produced identical
  // content, and every push about some *other* file.
  if (disk === base) return { kind: 'none' }

  // Clean buffer: there is nothing to lose. The common case by a wide margin,
  // because autosave fires on idle.
  if (buffer === base) return { kind: 'reload', text: disk }

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
