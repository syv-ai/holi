/**
 * Reminders as work across vaults (`MainPlugin.background`): every minute,
 * and once at the start as the catch-up for fires missed while Holi was quit,
 * sweep every registered vault that runs tasks and raise a native
 * notification for each reminder that is due (docs/features/tasks.md).
 *
 * The vaults' clones are refreshed at the head of every sweep, before it reads
 * or the runtime marks the watermark, so the delivered log resolves the same
 * clones the sweep just scanned. A vault whose scan throws (a stale registry
 * entry, a missing clone) is skipped, never a stall.
 *
 * Electron loads only once it starts (the notifier), so the module stays
 * importable under plain Node in the tests.
 */
import { snapshotTasks } from '@holi/shared'
import type { AppCtx, Disposer } from '../plugin-api'
import { createDeliveredLog, createReminderRuntime } from './runtime'
import type { VaultTasks } from './sweep'

export async function startReminders(ctx: AppCtx): Promise<Disposer> {
  const { createNotifier } = await import('./notify')
  const clonePaths = new Map<string, string>()
  const corpus = {
    async all(): Promise<VaultTasks[]> {
      const vaults = await ctx.vaults()
      clonePaths.clear()
      for (const v of vaults) clonePaths.set(v.remote, v.root)
      const scans = await Promise.all(
        vaults.map(async (v) => {
          const snapshot = await ctx.scan(v.root).catch(() => null)
          return snapshot ? { remote: v.remote, tasks: snapshotTasks(snapshot).items } : null
        }),
      )
      return scans.filter((v): v is VaultTasks => v !== null)
    },
  }
  const reminders = createReminderRuntime({
    corpus,
    // A click opens the task, switching vault when it is not the open one.
    notifier: createNotifier((remote, path) => ctx.open(remote, path)),
    delivered: createDeliveredLog((remote) => clonePaths.get(remote) ?? null),
    // An assigned task reminds only its assignees (docs/features/tasks.md).
    viewerLogin: ctx.viewerLogin,
  })
  reminders.start()
  return () => reminders.close()
}
