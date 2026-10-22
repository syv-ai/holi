/**
 * The app, once someone is signed in: what keeps a vault alive (opening it in
 * main, settings that follow the disk, the clock), the shell (ReUI's
 * app-shell-21 as published, `components/blocks/app-shell-21`) and the two flows that leave
 * the open vault, switching and adding one, which ask first when leaving would
 * stop something.
 *
 * A vault's theme file (`.holi/settings/theme.css`) does not reach the screen
 * here: the fresh frontend is shadcn's neutral theme until theming is rebuilt
 * on it.
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { AppShell } from '@/components/blocks/app-shell-21/components/app-shell'
import { Toaster } from '@/primitives'
import { OnboardingRitual } from '@/features/onboarding/OnboardingRitual'
import { leaveReasonsAtom } from '@/state/plugins'
import { activeModeAtom } from '../state/color-scheme'
import { tickNowAtom } from '../state/clock'
import { useVaultMembers } from '../state/members'
import { useSettingsFollowDisk } from '../state/settings'
import { applyVaultSwitchAtom, leavingVaultAtom } from '../state/vault-switch'
import { activeRemoteAtom, openVaultAtom } from '../state/vaults'
import { LeaveConfirm } from './leave-confirm'

export function Shell() {
  const activeRemote = useAtomValue(activeRemoteAtom)
  const colorMode = useAtomValue(activeModeAtom)
  const openVault = useSetAtom(openVaultAtom)
  const leaveReasons = useAtomValue(leaveReasonsAtom)
  const [leaving, setLeaving] = useAtom(leavingVaultAtom)
  const applySwitch = useSetAtom(applyVaultSwitchAtom)
  const [showAdd, setShowAdd] = useState(false)

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
    <>
      <AppShell onAddVault={addVault} />
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
    </>
  )
}
