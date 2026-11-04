/**
 * The sync state, and the words for it (docs/features/vaults-sync.md).
 *
 * Main computes the state and decides priority (`computeState` in
 * `main/vault/active-vault.ts`); the union and its label live here so the nav's
 * sync item and the agent's `holi sync status` say the same thing.
 *
 * No word for "saving": `up-to-date` over an uncommitted tree is a bounded
 * transient accepted on purpose, since the bytes are on disk and a label
 * toggling every few seconds of typing reports nothing.
 */

/**
 * The sync indicator's vocabulary.
 *
 * `up-to-date` means caught up both ways: nothing to push and nothing fetched
 * that is not merged. Commits that one side has and the other lacks are
 * `unsynced`, with both counts, so `holi sync status` never calls a vault that is ahead or behind up
 * to date. It is quiet: an autosave commit is ahead for the few seconds until
 * its coalesced push, and that is no cause for a warning.
 *
 *   - `offline`: the unpushed count rides it, since a push is failing.
 *   - `no-access`: a push rejected for *permission* is reported as exactly
 *     that, never dressed as a network failure.
 *   - `paused`: a vault on another branch stays open and readable while sync
 *     is off, and the user has to be told which is true.
 */
export type SyncState =
  | { kind: 'up-to-date' }
  | { kind: 'unsynced'; ahead: number; behind: number }
  | { kind: 'pulling' }
  | { kind: 'offline'; count: number }
  | { kind: 'no-access' }
  | { kind: 'conflict'; paths: string[] }
  | { kind: 'reconciling'; paths: string[] }
  | {
      kind: 'paused'
      reason: string
      /** True when someone asked for this pause and will lift it (the assistant
       *  holding the vault for its turn). Such a pause is news, not a warning:
       *  nothing is asked of the user and it clears itself. A pause that comes
       *  from the repo being blocked carries no flag, because it is indefinite
       *  and does want attention. */
      manual?: boolean
    }

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
    case 'unsynced':
      return {
        text: [
          state.ahead > 0 ? `${state.ahead} ahead` : null,
          state.behind > 0 ? `${state.behind} behind` : null,
        ]
          .filter((part) => part !== null)
          .join(', '),
        tone: 'quiet',
      }
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
