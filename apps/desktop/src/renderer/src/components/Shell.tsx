/**
 * The app, once someone is signed in: what keeps a vault alive (opening it in
 * main, its theme, settings that follow the disk, the clock), the shell
 * (`features/shell/AppShell.tsx`) and the two flows that leave the open vault,
 * switching and adding one, which ask first when leaving would stop something.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { PanelsTopLeft } from 'lucide-react'
import { Toaster } from '@/primitives'
import { AmbientGrain, EmptyState } from '@/composites'
import { OnboardingRitual } from '@/features/onboarding/OnboardingRitual'
import { AppShell } from '@/features/shell/AppShell'
import { leaveReasonsAtom } from '@/state/plugins'
import { activeModeAtom } from '../state/color-scheme'
import { tickNowAtom } from '../state/clock'
import { useVaultMembers } from '../state/members'
import { useSettingsFollowDisk } from '../state/settings'
import { useVaultTheme } from '../state/theme'
import { applyVaultSwitchAtom, leavingVaultAtom } from '../state/vault-switch'
import { activeRemoteAtom, openVaultAtom } from '../state/vaults'
import { LeaveConfirm } from './LeaveConfirm'

export function Shell() {
  const activeRemote = useAtomValue(activeRemoteAtom)
  const colorMode = useAtomValue(activeModeAtom)
  const openVault = useSetAtom(openVaultAtom)
  const leaveReasons = useAtomValue(leaveReasonsAtom)
  const [leaving, setLeaving] = useAtom(leavingVaultAtom)
  const applySwitch = useSetAtom(applyVaultSwitchAtom)
  const [showAdd, setShowAdd] = useState(false)

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

  /** Adding a vault opens it, leaving this one as a switch does. Asked at the
   *  trigger, before someone names a repo and waits for a clone. */
  const addVault = () => {
    if (leaveReasons.length > 0) setLeaving({ kind: 'add' })
    else setShowAdd(true)
  }

  return (
    <div data-slot="window-ground" className="relative flex h-screen text-foreground">
      <AmbientGrain />
      <AppShell onAddVault={addVault}>
        <EmptyState
          icon={PanelsTopLeft}
          title="Nothing open yet"
          description="Views come back one at a time in the new shell."
        />
      </AppShell>
      {showAdd && <OnboardingRitual mode="add-vault" onDismiss={() => setShowAdd(false)} />}
      {leaving !== null && (
        <LeaveConfirm
          intent={leaving.kind}
          onConfirm={() => {
            if (leaving.kind === 'switch') applySwitch(leaving.remote)
            else {
              setLeaving(null)
              setShowAdd(true)
            }
          }}
          onCancel={() => setLeaving(null)}
        />
      )}
      <Toaster theme={colorMode} position="bottom-center" />
    </div>
  )
}
