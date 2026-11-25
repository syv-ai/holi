/** Switch only the displayed vault. Runtime, plugin and session lifetimes are independent. */
import { atom } from 'jotai'
import { flushAllBuffers, freezeBuffers } from '@/lib/buffer-registry'
import { activeRemoteAtom, openedRemoteAtom } from './vaults'

/** Preserve departing editor text before changing the workspace. Failed writes keep selection. */
export const switchVaultAtom = atom(null, async (get, set, remote: string): Promise<void> => {
  if (remote === get(activeRemoteAtom)) return
  const release = freezeBuffers()
  try {
    await flushAllBuffers()
    set(openedRemoteAtom, null)
    set(activeRemoteAtom, remote)
  } finally {
    release()
  }
})
