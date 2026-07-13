import type { HealthStatus } from '@holi/shared'
import type { GithubOAuth } from '../git/oauth'
import { publicProcedure, router } from '../trpc'
import { authRouter } from './auth'
import { makeGithubRouter } from './github'
import { membershipRouter } from './membership'
import { notesRouter } from './notes'
import { remindersRouter } from './reminders'
import { snapshotsRouter } from './snapshots'
import { tasksRouter } from './tasks'
import { userStateRouter } from './user-state'
import { vaultsRouter } from './vaults'

export function makeAppRouter(opts: { githubOAuth: GithubOAuth | null }) {
  return router({
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
    github: makeGithubRouter(opts.githubOAuth),
  })
}

/** Static type for clients (desktop imports the type only). */
export type AppRouter = ReturnType<typeof makeAppRouter>
