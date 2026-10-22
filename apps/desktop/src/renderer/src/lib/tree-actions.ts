/**
 * Pure planning for the explorer's batch actions: the current doc paths plus a
 * request become concrete `{ from, to }` moves or copies. `useExplorerActions`
 * applies them.
 */
import {
  basename,
  expandToFiles,
  freeCopyPath,
  joinPath,
  parentOf,
  pathTaken,
  remapUnder,
} from './tree-paths'

export type Move = { from: string; to: string }
export type ClipboardData = { mode: 'cut' | 'copy'; paths: string[] }

/** Every distinct doc at or under any target — a folder fans out to its files. */
export function filesUnder(docPaths: string[], targets: string[]): string[] {
  const out = new Set<string>()
  for (const t of targets) for (const f of expandToFiles(docPaths, t)) out.add(f)
  return [...out]
}

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

/** Duplicate `targets` in place, each to its first free `… copy` name. */
export function planDuplicate(docPaths: string[], targets: string[]): Move[] {
  const claimed = new Set(docPaths)
  const isTaken = (p: string) => pathTaken(claimed, p)
  const copies: Move[] = []
  for (const src of targets) {
    const newRoot = freeCopyPath(isTaken, src)
    for (const from of expandToFiles(docPaths, src)) {
      const to = newRoot + from.slice(src.length)
      claimed.add(to)
      copies.push({ from, to })
    }
  }
  return copies
}

export type PastePlan =
  | { mode: 'move'; moves: Move[] }
  | { mode: 'copy'; copies: Move[] }

/** Paste the clipboard into `destFolder`: a cut moves, a copy clones to the first
 *  free name (a copy stays on the clipboard for repeat paste, VS Code-style). */
export function planPaste(
  docPaths: string[],
  clip: ClipboardData,
  destFolder: string,
): PastePlan {
  if (clip.mode === 'cut') {
    return { mode: 'move', moves: planMoveInto(docPaths, clip.paths, destFolder) }
  }
  const claimed = new Set(docPaths)
  const isTaken = (p: string) => pathTaken(claimed, p)
  const copies: Move[] = []
  for (const src of clip.paths) {
    const destRoot = freeCopyPath(isTaken, joinPath(destFolder, basename(src)))
    for (const from of expandToFiles(docPaths, src)) {
      const to = destRoot + from.slice(src.length)
      claimed.add(to)
      copies.push({ from, to })
    }
  }
  return { mode: 'copy', copies }
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

/** The human name for a delete preview: a multi-selection counts files, a folder
 *  names itself with its file count, a single file is just its path. Files,
 *  not notes: a folder or an app holds whatever it holds. */
export function deleteLabel(targets: string[], fileCount: number, isFolder: boolean): string {
  if (targets.length > 1) return `${fileCount} files`
  if (isFolder) return `${targets[0]}/ (${fileCount} file${fileCount === 1 ? '' : 's'})`
  return targets[0]!
}
