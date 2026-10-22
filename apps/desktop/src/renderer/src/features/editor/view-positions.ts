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
  /** `EditorView.scrollSnapshot()`, which a new view takes as `scrollTo`. */
  scroll: StateEffect<{ range: { head: number } }>
}

const positions = new Map<string, ViewPosition>()

const keyOf = (remote: string, path: string): string => `${remote}\n${path}`

function isOpen(workspace: Workspace, path: string): boolean {
  return workspace.panes.some((p) => p.tabs.some((t) => t.kind === 'note' && t.path === path))
}

/**
 * Keep where `view` is for its note while the note is still open in some
 * pane; forget it when the tab closed. Notes closed while another was showing
 * are forgotten here too.
 */
export function rememberPosition(
  remote: string,
  path: string,
  view: EditorView,
  workspace: Workspace,
): void {
  for (const key of positions.keys()) {
    const [r, p] = key.split('\n') as [string, string]
    if (r !== remote || !isOpen(workspace, p)) positions.delete(key)
  }
  if (!isOpen(workspace, path)) return
  const { anchor, head } = view.state.selection.main
  positions.set(keyOf(remote, path), { anchor, head, scroll: view.scrollSnapshot() })
}

/**
 * Where a new view of the note should open, if it was left somewhere: the
 * caret, kept inside the document as it now reads, and the scroll, unless the
 * document has since shrunk past it.
 */
export function rememberedPosition(
  remote: string,
  path: string,
  docLength: number,
): { selection: EditorSelection; scrollTo?: StateEffect<unknown> } | null {
  const at = positions.get(keyOf(remote, path))
  if (at === undefined) return null
  const clamp = (n: number): number => Math.min(n, docLength)
  return {
    selection: EditorSelection.single(clamp(at.anchor), clamp(at.head)),
    ...(at.scroll.value.range.head <= docLength ? { scrollTo: at.scroll } : {}),
  }
}
