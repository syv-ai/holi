import { atom } from 'jotai'
import type { SyncStatus } from '@holi/shared'

/** The only offline UI (D21): synced | syncing | offline. Never a dialog. */
export const syncStatusAtom = atom<SyncStatus>('offline')
