/**
 * The evaluator shell — `sweep` (pure) behind four injected seams: a Clock, a
 * TaskCorpus, a Notifier, and a DeliveredLog. Mirrors the house `createX(deps)`
 * pattern (`createRouter`/`createVaultHost`): Electron lives in the real adapters
 * the caller passes; tests pass in-memory ones and the core loads under vitest.
 *
 * `start()` runs one sweep immediately (the launch catch-up) then every `tickMs`.
 * `close()` sets a `closed` flag and clears the timer, and every tick re-checks
 * `closed` after its `await` so a sweep in flight when the app quits can't fire
 * into a torn-down runtime (the `active-vault` teardown pattern).
 */
import { createDeliveredLog } from './delivered-log'
import type { DeliveredLog } from './delivered-log'
import { localNow, sweep } from './sweep'
import type { VaultTasks } from './sweep'
import type { RemindersEvent } from './types'

export interface ReminderRuntime {
  start(): void
  close(): void
}

export interface ReminderRuntimeDeps {
  /** Clock — local wall-clock `YYYY-MM-DDTHH:MM`. Defaults to `localNow()`. */
  now?: () => string
  corpus: { all(): Promise<VaultTasks[]> }
  notifier: { fire(event: RemindersEvent): void }
  delivered: DeliveredLog
  /** Sweep interval. Defaults to 60s — minute granularity suits the 09:00 anchor. */
  tickMs?: number
}

export function createReminderRuntime(deps: ReminderRuntimeDeps): ReminderRuntime {
  const now = deps.now ?? localNow
  const tickMs = deps.tickMs ?? 60_000
  let closed = false
  let timer: ReturnType<typeof setInterval> | null = null

  async function tick(): Promise<void> {
    if (closed) return
    const vaults = await deps.corpus.all()
    if (closed) return // a sweep begun before `close()` must not fire after it
    const { event, marks } = sweep(vaults, now(), (remote) => deps.delivered.read(remote))
    if (!event) return
    deps.notifier.fire(event)
    for (const m of marks) deps.delivered.markDelivered(m.remote, m.path, m.fireAt)
  }

  return {
    start() {
      void tick() // launch catch-up
      timer = setInterval(() => void tick(), tickMs)
    },
    close() {
      closed = true
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

// Re-export so `index.ts` builds the real DeliveredLog from one module.
export { createDeliveredLog }
export type { DeliveredLog }
