/** The file tree's drop rule, apart from its DOM. */
import { parentOf } from './tree-paths'

/** A move that changes something: not where it already is, not into itself. */
export function canMoveInto(sources: string[], dest: string): boolean {
  return sources.every((s) => parentOf(s) !== dest && dest !== s && !dest.startsWith(`${s}/`))
}
