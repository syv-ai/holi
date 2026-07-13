import type { HealthStatus } from '@holi/shared'
import type { GithubApi } from '../git/github-api'
import type { GithubOAuth } from '../git/oauth'
import { publicProcedure, router } from '../trpc'
import { authRouter } from './auth'
import { makeGitRouter } from './git'
import { makeGithubRouter } from './github'
import { membershipRouter } from './membership'
import { notesRouter } from './notes'
import { remindersRouter } from './reminders'
import { snapshotsRouter } from './snapshots'
import { tasksRouter } from './tasks'
import { userStateRouter } from './user-state'
import { vaultsRouter } from './vaults'

/** Wiring endpoints fail cleanly when the GitHub OAuth app isn't configured;
 * git.status/syncNow never touch the API. */
const unconfiguredGithubApi: GithubApi = new Proxy({} as GithubApi, {
  get: () => () => {
    throw new Error('GitHub OAuth app is not configured on the server (GITHUB_CLIENT_ID/SECRET)')
  },
})

export function makeAppRouter(opts: {
  githubOAuth: GithubOAuth | null
  githubApi: GithubApi | null
  publicBaseUrl: string
}) {
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
    git: makeGitRouter({
      api: opts.githubApi ?? unconfiguredGithubApi,
      publicBaseUrl: opts.publicBaseUrl,
    }),
  })
}

/** Static type for clients (desktop imports the type only). */
export type AppRouter = ReturnType<typeof makeAppRouter>
