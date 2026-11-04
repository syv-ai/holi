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
import { flushAllBuffers, freezeBuffers } from '@/lib/buffer-registry'
import { leaveReasonsAtom } from './plugins'
import { activeRemoteAtom } from './vaults'

export type LeavingVault = { kind: 'switch'; remote: string } | { kind: 'add' } | null

/** The departure awaiting confirmation, or null. */
export const leavingVaultAtom = atom<LeavingVault>(null)

/**
 * The switch itself, once confirmed or when nothing needed asking. What was
 * typed goes to disk first, in the vault it was typed in: emptying the
 * workspace unmounts the editors, and after that they can no longer be asked.
 */
export const applyVaultSwitchAtom = atom(null, async (_get, set, remote: string): Promise<void> => {
  set(leavingVaultAtom, null)
  // The shell keeps each vault's workspace independently. Flush the old
  // vault before changing remotes; do not clear its tabs.
  const release = freezeBuffers()
  try {
    await flushAllBuffers()
    set(activeRemoteAtom, remote)
  } finally {
    release()
  }
})

/** Switch to `remote`, asking first when leaving would cost something. */
export const switchVaultAtom = atom(null, async (get, set, remote: string): Promise<void> => {
  if (remote === get(activeRemoteAtom)) return
  if (get(leaveReasonsAtom).length > 0) {
    set(leavingVaultAtom, { kind: 'switch', remote })
    return
  }
  await set(applyVaultSwitchAtom, remote)
})
