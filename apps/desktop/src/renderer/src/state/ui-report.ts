/**
 * Tell main what the person is looking at: the focused note and the open ones
 * (main writes the agent's per-turn focus file, the one thing the agent cannot
 * discover itself), and the recents (`holi vault recents`, and a vault app's
 * `holi.recents()`). One report to main whenever any of it changes.
 *
 * Set up once beside the vault's push subscriptions, not in a component, so it
 * keeps reporting whatever is mounted.
 */
import type { createStore } from 'jotai'
import { trpc } from '../lib/trpc'
import { activeTab, workspaceAtom } from './panes'
import { recentsAtom } from './recents'
import { activeRemoteAtom } from './vaults'

export function reportUiToMain(store: ReturnType<typeof createStore>): () => void {
  // Typing to the agent focuses the agent's own tab, so that tab keeps the
  // note that was focused before it: otherwise every prompt typed in Holi
  // would report no note at all. Open notes are counted across every pane.
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
    if (tab?.kind === 'note') focusedNote = tab.path
    else if (tab?.kind !== 'agent') focusedNote = null
    if (focusedNote !== null && !openPaths.includes(focusedNote)) focusedNote = null
    trpc.ui.report
      .mutate({ remote, focusedPath: focusedNote, openPaths, recents: store.get(recentsAtom) })
      .catch((e: unknown) => console.warn('[ui] report failed:', e))
  }
  // A tab switch changes the workspace and then the recents: one report for both.
  const schedule = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(send)
  }

  schedule()
  const offWorkspace = store.sub(workspaceAtom, schedule)
  const offRecents = store.sub(recentsAtom, schedule)
  const offRemote = store.sub(activeRemoteAtom, schedule)
  return () => {
    offWorkspace()
    offRecents()
    offRemote()
  }
}
