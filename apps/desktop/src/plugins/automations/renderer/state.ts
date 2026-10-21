/**
 * The vault's automations as the Agents view shows them
 * (docs/features/scheduled-agents.md). Main reads the files and this machine's
 * approvals and runs, and says `schedules` whenever any of them changes; this
 * side asks for the list again.
 *
 * What is open is core's `agentsSelectionAtom` under this plugin's id: an
 * automation by its path, `new` for a blank one, `new:<holi>` for one a Holi
 * carries out (its page's New habit), or `list` for the view with nothing
 * picked.
 */
import { atom } from 'jotai'
import {
  activeRemoteAtom,
  agentsSelectionAtom,
  type PluginEventHandler,
  type PluginStore,
} from '@/plugin-api'
import { schedulesCap, type ScheduleSummary } from './schedules-cap'

export type { ScheduleSummary }
export { schedulesCap }

/** The plugin's id: the owner of its rows in the Agents view. */
export const AUTOMATIONS_OWNER = 'automations'

export const automationsAtom = atom<ScheduleSummary[]>([])
export const automationsLoadedAtom = atom<'loading' | 'ready' | 'error'>('loading')

/** What the view shows: an automation's path, a new one (for a Holi), or
 *  nothing picked. Null while the view is not this plugin's. */
export const openAutomationAtom = atom((get) => {
  const sel = get(agentsSelectionAtom)
  return sel?.owner === AUTOMATIONS_OWNER ? sel.id : null
})

export const selectAutomationAtom = atom(null, (_get, set, id: string) =>
  set(agentsSelectionAtom, { owner: AUTOMATIONS_OWNER, id }),
)

async function reload(remote: string, store: PluginStore): Promise<void> {
  const list = await schedulesCap.list(remote)
  if (remote !== store.get(activeRemoteAtom)) return
  store.set(automationsAtom, list)
  store.set(automationsLoadedAtom, 'ready')
}

export const automationEvents: Readonly<Record<string, PluginEventHandler>> = {
  // An automation ran, was written, or turned on or off: ask again.
  schedules: ({ remote }, store) => {
    if (remote !== store.get(activeRemoteAtom)) return
    void reload(remote, store).catch(() => {})
  },
}

export const loadAutomationsAtom = atom(null, async (get, set) => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  set(automationsLoadedAtom, 'loading')
  try {
    set(automationsAtom, await schedulesCap.list(remote))
    set(automationsLoadedAtom, 'ready')
  } catch {
    set(automationsLoadedAtom, 'error')
  }
})

/** The list while the vault is open: asked a few times as it opens, since
 *  main may not have started this plugin yet. Returns the undo. */
export function automationsVault(remote: string, store: PluginStore): () => void {
  let gone = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const attempt = (n: number): void => {
    void reload(remote, store).catch(() => {
      if (gone) return
      if (n >= 5) store.set(automationsLoadedAtom, 'error')
      else timer = setTimeout(() => attempt(n + 1), 400 * (n + 1))
    })
  }
  attempt(0)
  return () => {
    gone = true
    if (timer !== null) clearTimeout(timer)
    store.set(automationsAtom, [])
    store.set(automationsLoadedAtom, 'loading')
  }
}
