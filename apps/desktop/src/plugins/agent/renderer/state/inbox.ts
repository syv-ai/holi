/**
 * The agent inbox, as the renderer holds it (docs/features/agent-inbox.md):
 * main's list, pushed as the agent's `inbox` event on every change, and the
 * one place an entry is opened, from its row or from its clicked banner.
 */
import { shownPathOrNull } from '@holi/shared'
import { atom } from 'jotai'
import { toast } from 'sonner'
import {
  activeRemoteAtom,
  activeVaultSettingsAtom,
  openPathAtom,
  type PluginEventHandler,
  type PluginStore,
} from '@/plugin-api'
import { agentCap } from '../agent-cap'
import { openSessionAtom } from './send'

/** The inbox as main tells it (`main/inbox/rules.ts`), read off its verb. */
export type InboxView = Awaited<ReturnType<typeof agentCap.inbox>>
export type InboxEntry = InboxView['entries'][number]

const EMPTY: InboxView = { entries: [], unread: 0 }

export const inboxAtom = atom<InboxView>(EMPTY)

/** Open what an entry points at: its note or file, else its session. */
export const openInboxEntryAtom = atom(null, (get, set, entry: InboxEntry): void => {
  const remote = get(activeRemoteAtom)
  if (!get(activeVaultSettingsAtom)?.agentInbox) return
  if (entry.path !== undefined) {
    // Main refused such a path when the notice was raised; the inbox file is
    // only this machine's, but it is a file on disk all the same.
    const path = shownPathOrNull(entry.path)
    if (remote !== null && path !== null) set(openPathAtom, path)
  } else if (entry.session !== undefined) {
    void set(openSessionAtom, entry.session)
      .then((res) => {
        if (!res.ok) toast.error('Could not open agent session', { description: res.message })
      })
      .catch((error: unknown) => {
        toast.error('Could not open agent session', {
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }
})

export const dismissInboxEntryAtom = atom(null, async (get, set, id: string): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null || !get(activeVaultSettingsAtom)?.agentInbox) return
  set(inboxAtom, await agentCap.inboxDismiss(remote, { id }))
})

/** The person is looking at the inbox: nothing in it is unread any more. */
export const markInboxSeenAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null || !get(activeVaultSettingsAtom)?.agentInbox || get(inboxAtom).unread === 0)
    return
  set(inboxAtom, await agentCap.inboxSeen(remote))
})

export const inboxEvents: Readonly<Record<string, PluginEventHandler>> = {
  inbox: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom) && store.get(activeVaultSettingsAtom)?.agentInbox)
      store.set(inboxAtom, payload as InboxView)
  },
  // Its banner was clicked; main has brought the window forward.
  'inbox-open': ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) store.set(openInboxEntryAtom, payload as InboxEntry)
  },
}

/** Fill the inbox for the open vault, and empty it on the way out. */
export function inboxVault(remote: string, store: PluginStore): () => void {
  let generation = 0
  let enabled: boolean | undefined
  const refresh = (): void => {
    const next = store.get(activeVaultSettingsAtom)?.agentInbox === true
    if (next === enabled) return
    enabled = next
    const request = ++generation
    if (!next) {
      store.set(inboxAtom, EMPTY)
      return
    }
    const asked = store.get(inboxAtom)
    void agentCap
      .inbox(remote)
      .then((view) => {
        if (
          request === generation &&
          store.get(activeRemoteAtom) === remote &&
          store.get(inboxAtom) === asked
        )
          store.set(inboxAtom, view)
      })
      .catch((error: unknown) => console.error('[agent] inbox:', error))
  }
  const unsubscribe = store.sub(activeVaultSettingsAtom, refresh)
  refresh()
  return () => {
    ++generation
    unsubscribe()
    store.set(inboxAtom, EMPTY)
  }
}
