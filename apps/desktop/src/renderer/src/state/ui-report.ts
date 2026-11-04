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
import { trpc } from '@/lib/trpc'
import { surfacesAtom } from './plugins'
import { recentsAtom } from './recents'
import { shellWorkspaceAtom } from './shell-tabs'
import { activeEntry, allTabs, entryViews, focusedTab } from './shell-workspace'
import { parseTabKey } from './tab-descriptor'
import { activeRemoteAtom } from './vaults'

/**
 * The lines selected in a note's editor, by the editor that last changed its
 * selection (`EditorPane`). Kept when that editor unmounts, so a selection
 * still counts while the person types to the agent in the same pane; a fresh
 * editor for the path opens on a caret and clears it, and a vault switch clears
 * it (`reportUiToMain`).
 */
export const editorSelectionAtom = atom<{ path: string; lines: LineRange } | null>(null)

/** How long a selection holds still before it is reported: a drag across a
 *  page is one report, not one per line. */
const SELECTION_QUIET_MS = 300

/** The document a tab key shows, or null for any other view. */
function docOf(key: string): string | null {
  const tab = parseTabKey(key)
  return tab?.kind === 'doc' ? tab.path : null
}

export function reportUiToMain(store: ReturnType<typeof createStore>): () => void {
  // Typing to the agent focuses the agent's own view (a session, the Agents
  // home, a surface that says so: `keepsFocusedNote`), which keeps a note:
  // otherwise every prompt typed in Holi would report no note at all. In a
  // split that is the note beside it, the one last focused there when it has
  // more than one; alone, the note focused before it. Open notes are counted
  // across every tab and split.
  let focusedNote: string | null = null
  // Nothing carries between vaults: the note kept for the agent's tab belonged
  // to the vault that was showing then, even when the new one has the same path.
  let focusedIn: string | null = null
  let queued = false

  const keepsNote = (key: string): boolean => {
    const tab = parseTabKey(key)
    if (tab?.kind === 'session' || tab?.kind === 'agents-home') return true
    return (
      tab?.kind === 'surface' && store.get(surfacesAtom).get(tab.surface)?.keepsFocusedNote === true
    )
  }

  const send = (): void => {
    queued = false
    const remote = store.get(activeRemoteAtom)
    if (remote === null) return
    if (remote !== focusedIn) {
      focusedNote = null
      focusedIn = remote
    }
    const workspace = store.get(shellWorkspaceAtom)
    const openPaths = [...new Set(allTabs(workspace).flatMap((key) => docOf(key) ?? []))]
    const entry = activeEntry(workspace)
    const beside = entry === null ? [] : entryViews(entry).flatMap((key) => docOf(key) ?? [])
    const focused = focusedTab(workspace)
    const here = focused === null ? null : docOf(focused)
    if (here !== null) focusedNote = here
    else if (focused !== null && keepsNote(focused)) {
      if (focusedNote === null || (beside.length > 0 && !beside.includes(focusedNote))) {
        focusedNote = beside[0] ?? focusedNote
      }
    } else focusedNote = null
    if (focusedNote !== null && !openPaths.includes(focusedNote)) focusedNote = null
    const surfaces = store.get(surfacesAtom)
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
  const offWorkspace = store.sub(shellWorkspaceAtom, schedule)
  const offRecents = store.sub(recentsAtom, schedule)
  // A selection, kept past its editor's unmount, is the old vault's too.
  const offRemote = store.sub(activeRemoteAtom, () => {
    store.set(editorSelectionAtom, null)
    schedule()
  })
  const offSelection = store.sub(editorSelectionAtom, scheduleSelection)
  return () => {
    offWorkspace()
    offRecents()
    offRemote()
    offSelection()
    if (selectionTimer !== null) clearTimeout(selectionTimer)
  }
}
