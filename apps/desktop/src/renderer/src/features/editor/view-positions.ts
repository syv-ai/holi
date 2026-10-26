/**
 * Where each open note was left: its caret and scroll, so switching back to
 * its tab shows it as it was (docs/features/tabs-panes.md).
 *
 * A pane renders only its active note, so a tab switch destroys the
 * `EditorView` and the next one is built from disk. The position is taken as
 * the view goes and handed to the next view of the same note. It is keyed by
 * vault and path, the tab's identity, so it follows a tab into another pane,
 * and it is dropped once no pane has the note open.
 */
import { EditorSelection, type StateEffect } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { Workspace } from '@/state/panes'

interface ViewPosition {
  anchor: number
  head: number
  /** Which side an empty caret binds to: a caret left at the body's start is
   *  bound below the frontmatter, and must come back bound the same way. */
  assoc: -1 | 0 | 1
  /** `EditorView.scrollSnapshot()`, which a new view takes as `scrollTo`. */
  scroll: StateEffect<{ range: { head: number } }>
}

/** By vault, then path. The workspace is emptied before a vault switch, so
 *  only the active vault's notes are ever open. */
const positions = new Map<string, Map<string, ViewPosition>>()

function isOpen(workspace: Workspace, path: string): boolean {
  return workspace.panes.some((p) => p.tabs.some((t) => t.kind === 'note' && t.path === path))
}

/**
 * Keep where `view` is for its note while the note is still open in some
 * pane; forget it when the tab closed. Notes closed while another was showing,
 * and other vaults, are forgotten here too. A renamed note is no longer open
 * under its old path, so its place is forgotten with it.
 */
export function rememberPosition(
  remote: string,
  path: string,
  view: EditorView,
  workspace: Workspace,
): void {
  for (const r of positions.keys()) if (r !== remote) positions.delete(r)
  const vault = positions.get(remote) ?? new Map<string, ViewPosition>()
  positions.set(remote, vault)
  for (const p of vault.keys()) if (!isOpen(workspace, p)) vault.delete(p)
  if (!isOpen(workspace, path)) return
  const { anchor, head, assoc } = view.state.selection.main
  vault.set(path, { anchor, head, assoc: assoc as -1 | 0 | 1, scroll: view.scrollSnapshot() })
}

/**
 * Where a new view of the note should open, if it was left somewhere: the
 * caret, kept inside the document as it now reads, and the scroll, unless the
 * document has since shrunk past it. `bodyStart` is where the body begins
 * (0 for a plain file): a caret is never put back above it, since frontmatter
 * may have grown above where the caret was while the tab was away.
 */
export function rememberedPosition(
  remote: string,
  path: string,
  docLength: number,
  bodyStart: number,
): { selection: EditorSelection; scrollTo?: StateEffect<unknown> } | null {
  const at = positions.get(remote)?.get(path)
  if (at === undefined) return null
  const clamp = (n: number): number => Math.min(Math.max(n, bodyStart), docLength)
  const anchor = clamp(at.anchor)
  const head = clamp(at.head)
  const assoc = head === bodyStart && bodyStart > 0 ? 1 : at.assoc
  return {
    selection: EditorSelection.create([
      anchor === head ? EditorSelection.cursor(head, assoc) : EditorSelection.range(anchor, head),
    ]),
    ...(at.scroll.value.range.head <= docLength ? { scrollTo: at.scroll } : {}),
  }
}
