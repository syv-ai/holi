/**
 * The `apps.*` capabilities Holi's own UI calls: an app's bridge calls, its
 * approvals, its log, and scaffolding one. Typed by hand, as a call into a
 * plugin is: they are the apps plugin's, and core does not import it.
 */
import type { AppAffordance, AppLogLevel } from '@holi/shared'
import { capClient, type UiCapability } from '@/lib/cap-client'

type AppCommit = { sha: string; author: string; email: string; date: string; login: string | null }

export const appsCap = capClient<{
  'apps.call': UiCapability<{ bundle: string; method: string; params?: unknown }, unknown>
  'apps.grants': UiCapability<
    { bundle: string },
    {
      codeHash: string
      affordances: { affordance: AppAffordance; granted: boolean }[]
      reasons: Partial<Record<AppAffordance, string>>
      added: AppCommit | null
      lastChange: AppCommit | null
    }
  >
  'apps.grant': UiCapability<{ bundle: string; affordances: string[]; codeHash: string }, boolean>
  'apps.log': UiCapability<{ bundle: string; level: AppLogLevel; text: string }, boolean>
  'apps.init': UiCapability<{ path: string }, { created: string[] }>
}>('apps')
