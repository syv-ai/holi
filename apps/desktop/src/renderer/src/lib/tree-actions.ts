/**
 * Pure planning for the explorer's batch actions: the current doc paths plus a
 * request become concrete `{ from, to }` moves or copies. `useExplorerActions`
 * applies them.
 */
import {
  basename,
  expandToFiles,
  joinPath,
  parentOf,
  remapUnder,
} from './tree-paths'

export type Move = { from: string; to: string }
/** Move `sources` into `destFolder`, dropping the no-op (already-there) moves. */
export function planMoveInto(
  docPaths: string[],
  sources: string[],
  destFolder: string,
): Move[] {
  return sources
    .flatMap((s) => remapUnder(docPaths, s, joinPath(destFolder, basename(s))))
    .filter((m) => m.from !== m.to)
}

/** Rename a folder to `newName` under its parent: the new path, the files it holds
 *  (empty ⇒ a transient folder the caller renames client-side), and the moves. */
export function planRenameFolder(
  docPaths: string[],
  folder: string,
  newName: string,
): { dest: string; files: string[]; moves: Move[] } {
  const dest = joinPath(parentOf(folder), newName)
  const files = expandToFiles(docPaths, folder)
  const moves =
    dest === folder ? [] : remapUnder(docPaths, folder, dest).filter((m) => m.from !== m.to)
  return { dest, files, moves }
}
