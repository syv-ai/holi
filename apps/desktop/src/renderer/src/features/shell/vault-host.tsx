/**
 * The app, once someone is signed in: what keeps a vault alive (opening it in
 * main, settings that follow the disk, the clock), the shell
 * (`app-shell.tsx`, adapted from ReUI's app-shell-21 block) and the two flows
 * that leave the open vault, switching and adding one, which ask first when
 * leaving would stop something.
 *
 */
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { AppShell } from '@/features/shell/app-shell'
import { Toaster } from '@/components/ui/sonner'
import { OnboardingRitual } from '@/features/onboarding/onboarding-ritual'
import { leaveReasonsAtom } from '@/state/plugins'
import { activeModeAtom } from '@/state/color-scheme'
import { tickNowAtom } from '@/state/clock'
import { useVaultMembers } from '@/state/members'
import { usePlanningFiles } from '@/state/planning'
import { useSettingsFollowDisk } from '@/state/settings'
import { useVaultTheme } from '@/state/vault-theme'
import { applyVaultSwitchAtom, leavingVaultAtom } from '@/state/vault-switch'
import {
  activeRemoteAtom,
  activeRemoteRevisionValueAtom,
  selectedVaultOpenAttemptedAtom,
  openVaultAtom,
} from '@/state/vaults'
import { LeaveVaultDialog } from './leave-vault-dialog'

export function VaultHost() {
  const activeRemote = useAtomValue(activeRemoteAtom)
  const activeRemoteRevision = useAtomValue(activeRemoteRevisionValueAtom)
  const openAttempted = useAtomValue(selectedVaultOpenAttemptedAtom)
  const colorMode = useAtomValue(activeModeAtom)
  const openVault = useSetAtom(openVaultAtom)
  const leaveReasons = useAtomValue(leaveReasonsAtom)
  const [leaving, setLeaving] = useAtom(leavingVaultAtom)
  const applySwitch = useSetAtom(applyVaultSwitchAtom)
  const [showAdd, setShowAdd] = useState(false)

  useSettingsFollowDisk()
  useVaultTheme()
  useVaultMembers()
  usePlanningFiles()

  // Keep `nowAtom` on the current minute (see `state/clock.ts`).
  const tickNow = useSetAtom(tickNowAtom)
  useEffect(() => {
    const id = setInterval(() => tickNow(), 30_000)
    return () => clearInterval(id)
  }, [tickNow])

  // Open each selected vault once. Document intents and recovery also own
  // opens, so their attempts live in vault state, not a shell-local ref.
  useEffect(() => {
    if (!activeRemote || openAttempted) return
    // Landed: main may send the opens it held for a window that had not
    // (a clicked reminder, `holi docs open`, a Holi link).
    void openVault(activeRemote).then((landed) => {
      if (landed) window.holi.vault.openReady()
    })
  }, [activeRemote, activeRemoteRevision, openAttempted, openVault])

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
        <LeaveVaultDialog
          intent={leaving.kind}
          onConfirm={() => {
            if (leaving.kind === 'switch') void applySwitch(leaving.remote)
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
