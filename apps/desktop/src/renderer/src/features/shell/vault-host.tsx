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
import { AppShell } from '@/features/shell/app-shell'
import { Toaster } from '@/primitives'
import { OnboardingRitual } from '@/features/onboarding/onboarding-ritual'
import { leaveReasonsAtom } from '@/state/plugins'
import { activeModeAtom } from '../../state/color-scheme'
import { tickNowAtom } from '../../state/clock'
import { useVaultMembers } from '../../state/members'
import { usePlanningFiles } from '../../state/planning'
import { useSettingsFollowDisk } from '../../state/settings'
import { applyVaultSwitchAtom, leavingVaultAtom } from '../../state/vault-switch'
import { activeRemoteAtom, openVaultAtom } from '../../state/vaults'
import { LeaveVaultDialog } from './leave-vault-dialog'

export function VaultHost() {
  const activeRemote = useAtomValue(activeRemoteAtom)
  const colorMode = useAtomValue(activeModeAtom)
  const openVault = useSetAtom(openVaultAtom)
  const leaveReasons = useAtomValue(leaveReasonsAtom)
  const [leaving, setLeaving] = useAtom(leavingVaultAtom)
  const applySwitch = useSetAtom(applyVaultSwitchAtom)
  const [showAdd, setShowAdd] = useState(false)

  useSettingsFollowDisk()
  useVaultMembers()
  usePlanningFiles()

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
    // Landed: main may send the opens it held for a window that had not
    // (a clicked reminder, `holi docs open`, a Holi link).
    void openVault(activeRemote).then(() => window.holi.vault.openReady())
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
        <LeaveVaultDialog
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
