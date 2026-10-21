/**
 * The app, once someone is signed in: a fresh start. What is kept is what
 * keeps a vault alive (opening it in main, its theme, settings that follow the
 * disk, the clock) and the Agents sidebar the agent plugin draws. Everything
 * else is to be built again from here.
 */
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef } from 'react'
import { Toaster } from '@/primitives'
import { AmbientGrain } from '@/composites'
import { runningPluginsAtom } from '@/state/plugins'
import { activeModeAtom } from '../state/color-scheme'
import { tickNowAtom } from '../state/clock'
import { useVaultMembers } from '../state/members'
import { useSettingsFollowDisk } from '../state/settings'
import { useVaultTheme } from '../state/theme'
import { activeRemoteAtom, openVaultAtom } from '../state/vaults'

export function Shell() {
  const activeRemote = useAtomValue(activeRemoteAtom)
  const colorMode = useAtomValue(activeModeAtom)
  const openVault = useSetAtom(openVaultAtom)
  // The one plugin that provides the Agents mode (the agent), if it runs.
  const agentsMode = useAtomValue(runningPluginsAtom).find((p) => p.agentsMode)?.agentsMode

  useVaultTheme()
  useSettingsFollowDisk()
  useVaultMembers()

  // Keep `nowAtom` on the current minute (see `state/clock.ts`).
  const tickNow = useSetAtom(tickNowAtom)
  useEffect(() => {
    const id = setInterval(() => tickNow(), 30_000)
    return () => clearInterval(id)
  }, [tickNow])

  // Open the active vault in main, once per remote: the only caller of
  // `vaults.open`, so a cold start and a switch both open here.
  const openedRemote = useRef<string | null>(null)
  useEffect(() => {
    if (!activeRemote || openedRemote.current === activeRemote) return
    openedRemote.current = activeRemote
    void openVault(activeRemote)
  }, [activeRemote, openVault])

  return (
    <div data-slot="window-ground" className="relative flex h-screen text-foreground">
      <AmbientGrain />
      <aside aria-label="Sidebar" className="flex h-full w-64 shrink-0 flex-col">
        <div data-window-band="nav" className="app-drag h-10 shrink-0" />
        <div className="flex min-h-0 flex-1 flex-col">{agentsMode && <agentsMode.sidebar />}</div>
      </aside>
      <main data-slot="content-panel" className="relative my-2 me-2 flex min-w-60 flex-1" />
      <Toaster theme={colorMode} position="bottom-center" />
    </div>
  )
}
