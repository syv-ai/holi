/**
 * The skills update a vault asks for on open (`autoUpdateSkills`,
 * docs/features/updates.md).
 *
 * It runs in main, after the open is through (seeded, opened, its plugins
 * started) and after the vault's first pull: a teammate may already have
 * brought this release's skills in, and a run ahead of the pull would write
 * the same change twice and leave the merge to sort it out. It writes only
 * what `pendingShipped` found, so a file that merely differs, with no base on
 * this machine, is left alone rather than staged as a conflict nobody asked
 * about. A vault left meanwhile is not touched.
 *
 * Plain Node, every effect injected, so it runs under test.
 */
import { pendingShipped, updateShipped, type UpdateReport } from './update'
import type { SeedContribution } from './types'

export interface UpdateOnOpenDeps {
  root: string
  /** The running Holi's version, recorded when the run brings something in. */
  release: string
  /** The open vault's first pull (`ActiveVault.caughtUp`): false when the
   *  vault closed before one caught up. */
  caughtUp(): Promise<boolean>
  /** Whether the vault this run is for is still the open one. */
  stillOpen(): boolean
  /** Whether the vault asks for this (`autoUpdateSkills`), read when it runs. */
  wanted(): Promise<boolean>
  contributions(): Promise<readonly SeedContribution[]>
  /** Runs the writing part one at a time with any other skills update. */
  exclusive<T>(job: () => Promise<T>): Promise<T>
}

/** The report of the run, or null when it did not run or found nothing. */
export async function updateOnOpen(deps: UpdateOnOpenDeps): Promise<UpdateReport | null> {
  if (!(await deps.caughtUp()) || !deps.stillOpen()) return null
  if (!(await deps.wanted())) return null
  return deps.exclusive(async () => {
    if (!deps.stillOpen()) return null
    const contributions = await deps.contributions()
    const pending = await pendingShipped(deps.root, contributions)
    if (pending.length === 0 || !deps.stillOpen()) return null
    return updateShipped(deps.root, contributions, { release: deps.release, only: pending })
  })
}
