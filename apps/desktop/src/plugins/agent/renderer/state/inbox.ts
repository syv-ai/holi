/**
 * The agent inbox, as the renderer holds it (docs/features/agent-inbox.md):
 * main's list, pushed as the agent's `inbox` event on every change, and the
 * one place an entry is opened, from its row or from its clicked banner.
 */
import { atom } from 'jotai'
import {
  activeRemoteAtom,
  requestArrivalAtom,
  type PluginEventHandler,
  type PluginStore,
} from '@/plugin-api'
import { agentCap } from '../agent-cap'
import { openSessionAtom } from './send'

/** The inbox as main tells it (`main/inbox/rules.ts`), read off its verb. */
export type InboxView = Awaited<ReturnType<typeof agentCap.inbox>>
export type InboxEntry = InboxView['entries'][number]

export const INBOX_SURFACE = 'inbox'

const EMPTY: InboxView = { entries: [], unread: 0 }

export const inboxAtom = atom<InboxView>(EMPTY)

/** Open what an entry points at: its note or file, as any arrival main asks
 *  for (beside the agent when it has the focus), else its session. */
export const openInboxEntryAtom = atom(null, (get, set, entry: InboxEntry): void => {
  const remote = get(activeRemoteAtom)
  if (entry.path !== undefined) {
    if (remote !== null) set(requestArrivalAtom, { remote, path: entry.path })
  } else if (entry.session !== undefined) {
    void set(openSessionAtom, entry.session).then((res) => {
      if (!res.ok) console.warn(`[agent] open ${entry.session} failed: ${res.message}`)
    })
  }
})

export const dismissInboxEntryAtom = atom(null, async (get, set, id: string): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null) return
  set(inboxAtom, await agentCap.inboxDismiss(remote, { id }))
})

/** The person is looking at the inbox: nothing in it is unread any more. */
export const markInboxSeenAtom = atom(null, async (get, set): Promise<void> => {
  const remote = get(activeRemoteAtom)
  if (remote === null || get(inboxAtom).unread === 0) return
  set(inboxAtom, await agentCap.inboxSeen(remote))
})

export const inboxEvents: Readonly<Record<string, PluginEventHandler>> = {
  inbox: ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) store.set(inboxAtom, payload as InboxView)
  },
  // Its banner was clicked; main has brought the window forward.
  'inbox-open': ({ remote, payload }, store) => {
    if (remote === store.get(activeRemoteAtom)) store.set(openInboxEntryAtom, payload as InboxEntry)
  },
}

/** Fill the inbox for the open vault, and empty it on the way out. */
export function inboxVault(remote: string, store: PluginStore): () => void {
  const asked = store.get(inboxAtom)
  void agentCap.inbox(remote).then((view) => {
    if (store.get(inboxAtom) === asked) store.set(inboxAtom, view)
  })
  return () => store.set(inboxAtom, EMPTY)
}
