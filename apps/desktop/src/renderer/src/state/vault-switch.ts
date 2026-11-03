/**
 * Leaving the active vault: by switching to another, or by adding one.
 *
 * A vault switch is a teardown in main (the old watcher and timers stop). The
 * shell keeps each vault's tabs apart (`shell-tabs.ts`), so the old vault's
 * leave the strip and come back with it. Setting the active remote is all that
 * is needed: Shell's open effect picks it up and runs the same sequence as a
 * cold start.
 *
 * Leaving may cost something running in the vault (the agent's busy
 * sessions, say: `leaveReasonsAtom`), so it asks first, HERE, before
 * `activeRemoteAtom` moves: once the atom changes the open effect closes the
 * old vault and there is nothing left to confirm.
 *
 * State rather than Shell's own: "switch to <vault>" is a command. Shell
 * renders the confirm from `leavingVaultAtom`; the `'add'` intent is set by
 * Shell's add-vault gesture.
 */
import { atom } from 'jotai'
import { leaveReasonsAtom } from './plugins'
import { activeRemoteAtom } from './vaults'

export type LeavingVault = { kind: 'switch'; remote: string } | { kind: 'add' } | null

/** The departure awaiting confirmation, or null. */
export const leavingVaultAtom = atom<LeavingVault>(null)

/** The switch itself, once confirmed or when nothing needed asking. */
export const applyVaultSwitchAtom = atom(null, (_get, set, remote: string): void => {
  set(leavingVaultAtom, null)
  set(activeRemoteAtom, remote)
})

/** Switch to `remote`, asking first when leaving would cost something. */
export const switchVaultAtom = atom(null, (get, set, remote: string): void => {
  if (remote === get(activeRemoteAtom)) return
  if (get(leaveReasonsAtom).length > 0) {
    set(leavingVaultAtom, { kind: 'switch', remote })
    return
  }
  set(applyVaultSwitchAtom, remote)
})
