/**
 * FR-21's one sync state, in words.
 *
 * The vocabulary is fixed by the requirement and this file does not extend it.
 * In particular there is **no word for "saving"**: `up-to-date` over a
 * not-yet-committed tree is a bounded transient that plan 4 settled and
 * accepted (`docs/plans/2026-07-22-main-process.md` §Resolved, D1) — the bytes
 * are on disk, every explicit action commits, and a chip that toggled every
 * three seconds of typing would cost a steady indicator to report nothing.
 *
 * It also does not decide priority. If a vault is both paused and conflicted,
 * `computeState` in main already chose which of those you see, and it has a
 * comment explaining what it costs to get that order backwards.
 */
import type { SyncState } from '../../../main/vault/active-vault'

export interface SyncLabel {
  text: string
  /** `quiet` = nothing is wrong, `busy` = a network operation is running,
   *  `warn` = it wants attention. Three, because the indicator lives in the
   *  vault dropdown and has room for a colour, not a sentence. */
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
      // network is stopping them (`prd/vaults-sync.md` §State display). The
      // count is what tells you how much is waiting; a bare "offline" hides it.
      return {
        text: state.count > 0 ? `offline — ${state.count} waiting` : 'offline',
        tone: 'warn',
      }
    case 'no-access':
      // FR-16: a permission refusal is its own thing, not a network failure.
      return { text: 'no write access', tone: 'warn' }
    case 'conflict':
      // FR-17 wants the count named on the banner; the dropdown has room for
      // the number but not the paths, and the banner carries those.
      return {
        text: `${state.paths.length} file${state.paths.length === 1 ? '' : 's'} conflict`,
        tone: 'warn',
      }
    case 'reconciling':
      return { text: 'reconciling', tone: 'warn' }
    case 'paused':
      // Main writes the reason as a whole sentence, because only main knows
      // why. Prefixing it here yields "paused: … — sync paused".
      return { text: state.reason, tone: 'warn' }
  }
}
