/**
 * Tell main what the person is looking at: the focused note, the lines selected
 * in it, and the open ones (main writes the agent's per-turn focus file, the one thing the agent cannot
 * discover itself), and the recents (`holi vault recents`, and a vault app's
 * `holi.recents()`). One report to main whenever any of it changes.
 *
 * Set up once beside the vault's push subscriptions, not in a component, so it
 * keeps reporting whatever is mounted.
 */
import type { LineRange } from '@holi/shared'
import { atom, type createStore } from 'jotai'
import { trpc } from '../lib/trpc'
import { activeTab, workspaceAtom } from './panes'
import { surfacesAtom } from './plugins'
import { recentsAtom } from './recents'
import { activeRemoteAtom } from './vaults'

/**
 * The lines selected in a note's editor, by the editor that last changed its
 * selection (`EditorPane`). Kept when that editor unmounts, so a selection
 * still counts while the person types to the agent in the same pane; a fresh
 * editor for the path opens on a caret and clears it.
 */
export const editorSelectionAtom = atom<{ path: string; lines: LineRange } | null>(null)

/** How long a selection holds still before it is reported: a drag across a
 *  page is one report, not one per line. */
const SELECTION_QUIET_MS = 300

export function reportUiToMain(store: ReturnType<typeof createStore>): () => void {
  // Typing to the agent focuses the agent's own tab, so a tab whose surface
  // says so (`keepsFocusedNote`) keeps the note that was focused before it:
  // otherwise every prompt typed in Holi would report no note at all. Open
  // notes are counted across every pane.
  let focusedNote: string | null = null
  let queued = false

  const send = (): void => {
    queued = false
    const remote = store.get(activeRemoteAtom)
    if (remote === null) return
    const workspace = store.get(workspaceAtom)
    const tab = activeTab(workspace)
    const openPaths = workspace.panes.flatMap((p) =>
      p.tabs.flatMap((t) => (t.kind === 'note' ? [t.path] : [])),
    )
    const surfaces = store.get(surfacesAtom)
    if (tab?.kind === 'note') focusedNote = tab.path
    else if (tab === null || surfaces.get(tab.surface)?.keepsFocusedNote !== true)
      focusedNote = null
    if (focusedNote !== null && !openPaths.includes(focusedNote)) focusedNote = null
    const selection = store.get(editorSelectionAtom)
    trpc.ui.report
      .mutate({
        remote,
        focusedPath: focusedNote,
        selection: selection !== null && selection.path === focusedNote ? selection.lines : null,
        openPaths,
        // Only what `holi.open` can open: an unlisted surface's tabs (a
        // terminal) are opened by their plugin's own controls.
        recents: store
          .get(recentsAtom)
          .filter((e) => e.kind !== 'surface' || surfaces.get(e.key)?.unlisted !== true),
      })
      .catch((e: unknown) => console.warn('[ui] report failed:', e))
  }
  // A tab switch changes the workspace and then the recents: one report for both.
  const schedule = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(send)
  }

  // A selection waits until it holds still; anything else reports at once,
  // carrying whatever is selected by then.
  let selectionTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleSelection = (): void => {
    if (selectionTimer !== null) clearTimeout(selectionTimer)
    selectionTimer = setTimeout(() => {
      selectionTimer = null
      schedule()
    }, SELECTION_QUIET_MS)
  }

  schedule()
  const offWorkspace = store.sub(workspaceAtom, schedule)
  const offRecents = store.sub(recentsAtom, schedule)
  const offRemote = store.sub(activeRemoteAtom, schedule)
  const offSelection = store.sub(editorSelectionAtom, scheduleSelection)
  return () => {
    offWorkspace()
    offRecents()
    offRemote()
    offSelection()
    if (selectionTimer !== null) clearTimeout(selectionTimer)
  }
}
