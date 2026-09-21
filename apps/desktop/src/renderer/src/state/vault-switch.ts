/**
 * Leaving the active vault: by switching to another, or by adding one.
 *
 * A vault switch is a teardown in main — the old watcher and timers stop — so
 * the tabs over the old vault have to go with it. Setting the active remote is
 * all that is needed: Shell's open effect picks it up and runs the same
 * open → daily → sweep sequence as cold start.
 *
 * …and it ends every session in the vault, which is worth asking about first
 * (D100). The question has to be asked HERE, before `activeRemoteAtom` moves:
 * the open effect reacts to that atom by opening the new vault, which is what
 * closes the old one and takes its sessions with it. By the time the atom has
 * changed there is nothing left to confirm.
 *
 * State rather than Shell's own (D102): "switch to <vault>" is a command, and
 * a command runs from a key, the menu or the palette, none of which can reach
 * a component's `useState`. Shell still renders the confirm from
 * `leavingVaultAtom`; the `'add'` intent is set by Shell's add-vault gesture,
 * whose continuation (showing the ritual) is Shell's own.
 */
import { atom } from 'jotai'
import { sessionsWorthAsking } from '../lib/agent-notices'
import { agentSessionsAtom } from './agent'
import { emptyWorkspace, workspaceAtom } from './panes'
import { activeRemoteAtom } from './vaults'

export type LeavingVault = { kind: 'switch'; remote: string } | { kind: 'add' } | null

/** The departure awaiting confirmation, or null. */
export const leavingVaultAtom = atom<LeavingVault>(null)

/** The switch itself, once confirmed or when nothing needed asking. */
export const applyVaultSwitchAtom = atom(null, (_get, set, remote: string): void => {
  set(leavingVaultAtom, null)
  set(workspaceAtom, emptyWorkspace())
  set(activeRemoteAtom, remote)
})

/** Switch to `remote`, asking first when a session would be lost. */
export const switchVaultAtom = atom(null, (get, set, remote: string): void => {
  if (remote === get(activeRemoteAtom)) return
  if (sessionsWorthAsking(get(agentSessionsAtom)).length > 0) {
    set(leavingVaultAtom, { kind: 'switch', remote })
    return
  }
  set(applyVaultSwitchAtom, remote)
})
