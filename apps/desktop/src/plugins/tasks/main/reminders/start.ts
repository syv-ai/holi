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
 */
import { snapshotTasks } from '../../shared/task-file'
import type { AppCtx, Disposer } from '../../../../main/plugin-api'
import { createNotifier } from './notify'
import { createDeliveredLog, createReminderRuntime } from './runtime'
import type { VaultTasks } from './sweep'

export function startReminders(ctx: AppCtx): Disposer {
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
    notifier: createNotifier(ctx),
    delivered: createDeliveredLog((remote) => clonePaths.get(remote) ?? null),
    // An assigned task reminds only its assignees (docs/features/tasks.md).
    viewerLogin: ctx.viewerLogin,
  })
  reminders.start()
  return () => reminders.close()
}
