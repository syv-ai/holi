/** Exercise real renderer vault workflows from plugin tests without widening
 * the production plugin interface to permit opening vaults.
 */
import type { createStore } from 'jotai'
import { loadVaultsAtom, openVaultAtom } from '@/state/vaults'

export function vaultWorkflow(store: ReturnType<typeof createStore>) {
  return {
    loadRegistered: () => store.set(loadVaultsAtom),
    open: (remote: string) => store.set(openVaultAtom, remote),
  }
}
