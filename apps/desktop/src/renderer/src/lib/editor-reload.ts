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
