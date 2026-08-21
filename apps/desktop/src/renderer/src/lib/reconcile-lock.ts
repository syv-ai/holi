/**
 * Whether an open document is locked because a reconcile is resolving it
 * (`prd/vaults-sync.md` FR-19).
 */
import type { SyncState } from '../../../main/vault/active-vault'

export function isLockedForReconcile(state: SyncState, path: string): boolean {
  return state.kind === 'reconciling' && state.paths.includes(path)
}
