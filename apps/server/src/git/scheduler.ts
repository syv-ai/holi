/** Poll loop (reminders/evaluator.ts pattern): export when a vault has been
 * dirty-and-quiet (or dirty too long), and fetch on the hourly backstop even
 * when idle — webhooks are latency, this loop is correctness. */
import { eq, max } from 'drizzle-orm'
import type { Bus } from '../bus'
import { config } from '../config'
import type { Db } from '../db/client'
import { docs, vaultGit } from '../db/schema'
import type { GetLiveDoc } from '../trpc'
import { syncVault, type SyncDeps } from './sync'

export interface SchedulerTunables {
  quietMs: number
  maxQuietMs: number
  fetchBackstopMs: number
}

export function shouldSync(
  row: { lastExportAt: Date | null; lastFetchAt: Date | null },
  latestDocChange: Date | null,
  now: Date,
  tunables: SchedulerTunables = config.git,
): boolean {
  const dirty =
    latestDocChange !== null && (row.lastExportAt === null || latestDocChange > row.lastExportAt)
  if (dirty) {
    const quiet = now.getTime() - latestDocChange.getTime() >= tunables.quietMs
    const overdue =
      row.lastExportAt !== null && now.getTime() - row.lastExportAt.getTime() >= tunables.maxQuietMs
    if (quiet || overdue || row.lastExportAt === null) return true
  }
  const lastFetch = row.lastFetchAt?.getTime() ?? 0
  return now.getTime() - lastFetch >= tunables.fetchBackstopMs
}

export function createGitScheduler(deps: {
  db: Db
  getLiveDoc: GetLiveDoc
  /** Task ingest mutates records, and every task mutation emits on the bus. */
  bus: Bus
  mirrorDir?: string
  /** Test seam. */
  syncImpl?: (deps: SyncDeps, vaultId: string) => Promise<void>
}) {
  const sync = deps.syncImpl ?? syncVault
  let timer: NodeJS.Timeout | undefined
  let stopped = false

  async function tick(now = new Date()): Promise<void> {
    const rows = await deps.db
      .select()
      .from(vaultGit)
      .where(eq(vaultGit.status, 'ok'))
    for (const row of rows) {
      const [agg] = await deps.db
        .select({ latest: max(docs.updatedAt) })
        .from(docs)
        .where(eq(docs.vaultId, row.vaultId))
      if (shouldSync(row, agg?.latest ?? null, now)) {
        try {
          await sync(
            { db: deps.db, bus: deps.bus, getLiveDoc: deps.getLiveDoc, mirrorDir: deps.mirrorDir },
            row.vaultId,
          )
        } catch (err) {
          console.error(`[git] sync failed for vault ${row.vaultId}`, err)
        }
      }
    }
  }

  function start(): void {
    const loop = async (): Promise<void> => {
      if (stopped) return
      await tick().catch((err) => console.error('[git] scheduler tick failed', err))
      if (!stopped) timer = setTimeout(loop, config.git.tickMs)
    }
    void loop()
  }

  function stop(): void {
    stopped = true
    clearTimeout(timer)
  }

  return { start, stop, tick }
}
