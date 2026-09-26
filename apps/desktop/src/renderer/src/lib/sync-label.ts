/**
 * The vault's one sync state, in words (docs/features/vaults-sync.md).
 *
 * No word for "saving": `up-to-date` over an uncommitted tree is a bounded
 * transient accepted on purpose, since the bytes are on disk and a label
 * toggling every few seconds of typing reports nothing.
 *
 * Priority is not decided here: `computeState` in main chooses.
 */
import type { SyncState } from '../../../main/vault/active-vault'

export interface SyncLabel {
  text: string
  /** `quiet` = nothing is wrong, `busy` = a network operation is running,
   *  `warn` = it wants attention. */
  tone: 'quiet' | 'busy' | 'warn'
}

export function syncLabel(state: SyncState): SyncLabel {
  switch (state.kind) {
    case 'up-to-date':
      return { text: 'up to date', tone: 'quiet' }
    case 'pulling':
      return { text: 'pulling', tone: 'busy' }
    case 'offline':
      // Push is automatic, so unpushed commits are only worth naming when the
      // network is stopping them.
      return {
        text: state.count > 0 ? `offline — ${state.count} waiting` : 'offline',
        tone: 'warn',
      }
    case 'no-access':
      // A permission refusal is not a network failure.
      return { text: 'no write access', tone: 'warn' }
    case 'conflict':
      // The count only; the banner carries the paths.
      return {
        text: `${state.paths.length} file${state.paths.length === 1 ? '' : 's'} conflict`,
        tone: 'warn',
      }
    case 'reconciling':
      return { text: 'reconciling', tone: 'warn' }
    case 'paused':
      // A manual pause is the assistant holding the vault for its turn. It
      // lifts itself and asks nothing of the user, so it is quiet; the session
      // indicators already say the assistant is working.
      if (state.manual) return { text: 'sync paused', tone: 'quiet' }
      // Main writes a blocked reason as a whole sentence; do not prefix it.
      return { text: state.reason, tone: 'warn' }
  }
}
