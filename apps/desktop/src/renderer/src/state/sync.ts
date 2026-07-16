import { atom } from 'jotai'
import type { SyncStatus } from '@holi/shared'

/** The only offline UI (D21): synced | syncing | offline. Never a dialog. */
export const syncStatusAtom = atom<SyncStatus>('offline')

/** An agent is mid-write on the open note (D37). Fed from the doc session's awareness
 * by EditorPane; scoped to the open doc, so switching notes resets it. */
export const agentEditingAtom = atom(false)
