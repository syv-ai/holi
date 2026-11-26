import { atom } from 'jotai'
import { capClient as productionCapClient } from '../../src/renderer/src/lib/cap-client'

export { activeRemoteAtom } from '../../src/renderer/src/plugin-api/index'
export const vimCodeEditingAtom = atom(false)
export const closeSurfaceTabsAtom = atom(null, () => {})
export const openSurfaceAtom = atom(null, () => {})
export const surfaceTabIdsAtom = (_surface: string, _remote: string) => atom<string[]>([])
export const openExternal = () => Promise.resolve()
export const capClient = productionCapClient
export type PluginStore = { get: (atom: any) => any; set: (...args: any[]) => any }
export type PluginEventHandler = (event: any, store: PluginStore) => void
export type CommandMenuEntry = any
export type SurfaceTabLook = any
