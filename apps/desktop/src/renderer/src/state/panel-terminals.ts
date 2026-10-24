/**
 * The bottom panel's shells as the renderer knows them (docs/features/status-bar.md).
 * Main runs them (`main/terminal/terminals.ts`); this holds their list, which
 * one is in front, and routes each push of output to its xterm.
 *
 * Output routing: an xterm built after its shell printed asks main for what
 * it printed (`terminal.replay`) and, until that answer lands, drops the
 * live pushes. Main sends the pushes and the answer down the one window
 * channel in order, so what arrived before the answer is in it and what
 * arrives after is not: nothing doubles and nothing is lost.
 */
import { atom, useStore } from 'jotai'
import { useEffect } from 'react'
import type { TerminalInfo } from '../../../main/terminal/terminals'
import { trpc } from '@/lib/trpc'
import { activeRemoteAtom } from '@/state/vaults'
import { bottomPanelAtom } from '@/state/bottom-panel'

export type { TerminalInfo }

export const panelTerminalsAtom = atom<readonly TerminalInfo[]>([])
export const activePanelTerminalAtom = atom<string | null>(null)
/** Why the last terminal would not start (node-pty not loading, say), or null. */
export const panelTerminalErrorAtom = atom<string | null>(null)

/** Where each terminal's live output goes, once its xterm is built. */
const sinks = new Map<string, (data: string) => void>()

/** Route `id`'s output to `write` from now on. Returns the undo. */
export function registerTerminalSink(id: string, write: (data: string) => void): () => void {
  sinks.set(id, write)
  return () => {
    if (sinks.get(id) === write) sinks.delete(id)
  }
}

/** The list after `id` went: the one beside it comes forward. */
export function afterRemoval(
  list: readonly TerminalInfo[],
  active: string | null,
  id: string,
): { list: TerminalInfo[]; active: string | null } {
  const index = list.findIndex((t) => t.id === id)
  const next = list.filter((t) => t.id !== id)
  if (active !== id) return { list: next, active }
  const neighbour = next[Math.min(Math.max(index, 0), next.length - 1)]
  return { list: next, active: neighbour?.id ?? null }
}

/**
 * Follow the shells' output and exits, and reload the list when the vault
 * changes (main stopped the old vault's shells as it left). Mounted once,
 * by the app shell.
 */
export function usePanelTerminals(): void {
  const store = useStore()
  useEffect(() => {
    const offData = window.holi?.terminal?.onData(({ remote, id, data }) => {
      if (remote === store.get(activeRemoteAtom)) sinks.get(id)?.(data)
    })
    const offExit = window.holi?.terminal?.onExit(({ remote, id, exitCode }) => {
      if (remote !== store.get(activeRemoteAtom)) return
      store.set(panelTerminalsAtom, (list) =>
        list.map((t) => (t.id === id ? { ...t, exitCode } : t)),
      )
    })
    const load = (remote: string | null) => {
      store.set(panelTerminalsAtom, [])
      store.set(activePanelTerminalAtom, null)
      if (remote === null) return
      trpc.terminal.list
        .query({ remote })
        .then((list) => {
          if (store.get(activeRemoteAtom) !== remote) return
          store.set(panelTerminalsAtom, list)
          store.set(activePanelTerminalAtom, list[0]?.id ?? null)
        })
        .catch((err: unknown) => console.error('[terminal] list failed:', err))
    }
    load(store.get(activeRemoteAtom))
    const offRemote = store.sub(activeRemoteAtom, () => load(store.get(activeRemoteAtom)))
    return () => {
      offData?.()
      offExit?.()
      offRemote()
    }
  }, [store])
}

/** + : another shell in the open vault, in front. */
export const createPanelTerminalAtom = atom(
  null,
  async (get, set, size: { cols: number; rows: number } = { cols: 80, rows: 24 }) => {
    const remote = get(activeRemoteAtom)
    if (remote === null) return
    set(panelTerminalErrorAtom, null)
    try {
      const opened = await trpc.terminal.create.mutate({ remote, ...size })
      if (!opened.ok) {
        set(panelTerminalErrorAtom, opened.message)
        return
      }
      set(panelTerminalsAtom, (list) => [...list, opened.terminal])
      set(activePanelTerminalAtom, opened.terminal.id)
    } catch (err) {
      set(panelTerminalErrorAtom, err instanceof Error ? err.message : String(err))
    }
  },
)

/** A terminal's ×: stop its shell and forget it. */
export const killPanelTerminalAtom = atom(null, async (get, set, id: string) => {
  const remote = get(activeRemoteAtom)
  const next = afterRemoval(get(panelTerminalsAtom), get(activePanelTerminalAtom), id)
  set(panelTerminalsAtom, next.list)
  set(activePanelTerminalAtom, next.active)
  // The last shell gone takes the panel with it, as in VS Code; otherwise
  // the Terminal tab would start a new one at once.
  const panel = get(bottomPanelAtom)
  if (next.list.length === 0 && panel.open && panel.tab === 'terminal') {
    set(bottomPanelAtom, { ...panel, open: false, maximized: false })
  }
  if (remote === null) return
  await trpc.terminal.kill
    .mutate({ remote, id })
    .catch((err: unknown) => console.error('[terminal] kill failed:', err))
})
