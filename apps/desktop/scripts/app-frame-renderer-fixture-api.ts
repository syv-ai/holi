import { atom } from 'jotai'
import { capClient as productionCapClient } from '../src/renderer/src/lib/cap-client'
import { vimCodeEditingAtom } from '../src/renderer/src/state/preferences'
import { registerHostHintAdapter } from '../src/renderer/src/lib/host-hints'

export { vimCodeEditingAtom, registerHostHintAdapter }
export type {
  HostHintAdapter,
  HostHintAdapterTarget,
  HostHintTarget,
} from '../src/renderer/src/lib/host-hints'

export const activeRemoteAtom = atom<string | null>('ada/a')
export const activeModeAtom = atom('dark')
export const closeSurfaceTabAtom = atom(null, () => {})
export const snapshotAtom = atom<{
  files: { path: string; updatedAt?: string; modifiedAt?: string }[]
  docs: { path: string; updatedAt: string }[]
  claimed: Record<string, { items: unknown[] }>
}>({ files: [], docs: [], claimed: {} })
export const historyEpochsAtom = atom({ all: 0, byPath: {} as Record<string, number> })
export const recentsAtom = atom([])
export const byRecency = (_recents: unknown[], _surface: string, ids: string[]) => ids
export const syncStateAtom = atom({})
export const agentSessionRowsAtom = atom([])
export const openPathAtom = atom(null, () => {})
export const openSurfaceAtom = atom(null, () => {})
export const openTabAtom = atom(null, () => {})
export const surfacesAtom = atom([])
export const cn = (...values: unknown[]) => values.filter(Boolean).join(' ')
export const FileHistoryDialog = () => null
export const openExternal = () => Promise.resolve()
export const capClient = productionCapClient
