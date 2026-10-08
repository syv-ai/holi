/**
 * The app updater's state, and when a check is worth running
 * (docs/features/updates.md). Pure: no Electron, no I/O, so the transitions
 * are pinned by tests rather than by shipping a release to find out.
 *
 * The trap it exists to avoid: once an update has been found, a further check
 * makes electron-updater announce it again, and a download mid-flight must not
 * be wiped by a check that lands during it.
 */

export type UpdateState = 'idle' | 'checking' | 'available' | 'downloading' | 'ready'

/** Everything the renderer knows about updating Holi, pushed whole on change. */
export interface UpdateStatus {
  /** False in a dev build, where there is nothing to update. */
  supported: boolean
  /** Whether Holi checks on its own (Settings → Updates). */
  enabled: boolean
  /** The running version. */
  version: string
  state: UpdateState
  /** The version found, from `available` until it is installed. */
  availableVersion: string | null
  /** 0-100 while downloading, else null. */
  percent: number | null
  /** Epoch ms of the last check that answered, either way. */
  lastCheckAt: number | null
  /** Epoch ms a check in flight began, so a stuck one can be retried. */
  checkStartedAt: number | null
  lastError: string | null
}

export type UpdateEvent =
  | { type: 'check-started' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded' }
  | { type: 'error'; message: string }

/** Background checks no closer together than this. */
export const CHECK_COOLDOWN_MS = 5 * 60 * 1000
/** A check with no answer for this long is dead, so it cannot block "Check
 *  now" forever. */
export const CHECK_STALE_MS = 60 * 1000

export function initialStatus(input: {
  supported: boolean
  enabled: boolean
  version: string
}): UpdateStatus {
  return {
    ...input,
    state: 'idle',
    availableVersion: null,
    percent: null,
    lastCheckAt: null,
    checkStartedAt: null,
    lastError: null,
  }
}

/** An update is in hand: a further check can only cause churn. */
function settled(state: UpdateState): boolean {
  return state === 'available' || state === 'downloading' || state === 'ready'
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0
  return Math.max(0, Math.min(100, Math.round(percent)))
}

export function reduce(status: UpdateStatus, event: UpdateEvent, now: number): UpdateStatus {
  switch (event.type) {
    case 'check-started':
      return {
        ...status,
        // Never back to "checking" over an update already held.
        state: settled(status.state) ? status.state : 'checking',
        checkStartedAt: now,
        lastError: null,
      }

    case 'available':
      return {
        ...status,
        // electron-updater re-announces a release it is already downloading.
        state:
          status.state === 'downloading' || status.state === 'ready' ? status.state : 'available',
        availableVersion: event.version,
        lastCheckAt: now,
        checkStartedAt: null,
      }

    case 'not-available':
      if (settled(status.state)) return { ...status, lastCheckAt: now, checkStartedAt: null }
      return {
        ...status,
        state: 'idle',
        availableVersion: null,
        percent: null,
        lastCheckAt: now,
        checkStartedAt: null,
      }

    case 'progress':
      return {
        ...status,
        state: 'downloading',
        percent: clampPercent(event.percent),
        checkStartedAt: null,
      }

    case 'downloaded':
      return { ...status, state: 'ready', percent: 100, checkStartedAt: null, lastError: null }

    case 'error':
      return {
        ...status,
        // A failed download leaves the update to retry; a failed check goes
        // quiet. Anything else keeps its state.
        state:
          status.state === 'downloading'
            ? 'available'
            : status.state === 'checking'
              ? 'idle'
              : status.state,
        percent: null,
        lastError: event.message,
        lastCheckAt: now,
        checkStartedAt: null,
      }
  }
}

/**
 * Whether to run a check now. A person's "Check now" skips the cooldown, since
 * someone is waiting on it; nothing skips an update already in hand.
 */
export function shouldCheck(
  status: UpdateStatus,
  source: 'user' | 'background',
  now: number,
): boolean {
  if (!status.supported) return false
  if (source === 'background' && !status.enabled) return false
  if (settled(status.state)) return false
  if (status.state === 'checking') {
    return status.checkStartedAt !== null && now - status.checkStartedAt >= CHECK_STALE_MS
  }
  if (source === 'user') return true
  return status.lastCheckAt === null || now - status.lastCheckAt >= CHECK_COOLDOWN_MS
}
