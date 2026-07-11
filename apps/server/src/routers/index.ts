import type { HealthStatus } from '@holi/shared'
import { publicProcedure, router } from '../trpc'
import { authRouter } from './auth'
import { membershipRouter } from './membership'
import { notesRouter } from './notes'
import { remindersRouter } from './reminders'
import { snapshotsRouter } from './snapshots'
import { tasksRouter } from './tasks'
import { userStateRouter } from './user-state'
import { vaultsRouter } from './vaults'

export const appRouter = router({
  health: publicProcedure.query(
    (): HealthStatus => ({ ok: true, service: 'holi-server', time: new Date().toISOString() }),
  ),
  auth: authRouter,
  vaults: vaultsRouter,
  membership: membershipRouter,
  notes: notesRouter,
  snapshots: snapshotsRouter,
  tasks: tasksRouter,
  reminders: remindersRouter,
  userState: userStateRouter,
})

export type AppRouter = typeof appRouter
