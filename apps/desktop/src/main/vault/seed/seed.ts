/**
 * Write what a vault must have, from every part of Holi that seeds one (each a
 * `SeedContribution`: core, the agent, PDF).
 *
 * **Seeding runs on vault creation, adoption AND every open**, but what an open
 * may do is narrow. Shipped files (skills, hooks) are written only when the
 * vault is created: after that they are the vault's, and a newer version
 * reaches them only through `holi skills update` (`update.ts`).
 *
 * `USER.local.md` is deliberately NOT seeded: it is machine-local (its name
 * says so), and the agent creates it when it first learns something about the
 * user.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vaultRelPath, VAULT_MARKER_FILE } from '@holi/shared'
import { writeAtomic } from '../vault-files'
import { recordSeeded } from './state'
import type { SeedContribution, SeedResult } from './types'

const exists = async (root: string, rel: string): Promise<boolean> =>
  (await readFile(join(root, rel)).catch(() => null)) !== null

/**
 * Every contribution's tables, checked to claim each path once. Two
 * contributions seeding one path would make the winner depend on list order.
 */
function tables(contributions: readonly SeedContribution[]) {
  const owner = new Map<string, string>()
  const claim = (rel: string, id: string) => {
    const prior = owner.get(rel)
    if (prior !== undefined) throw new Error(`${rel} is seeded by both ${prior} and ${id}`)
    owner.set(rel, id)
  }
  const once: [string, string | Uint8Array][] = []
  const shipped: [string, string][] = []
  const merged: [string, NonNullable<SeedContribution['merge']>[string]][] = []
  for (const c of contributions) {
    for (const [rel, merge] of Object.entries(c.merge ?? {})) {
      claim(rel, c.id)
      merged.push([rel, merge])
    }
    for (const [rel, content] of Object.entries(c.once)) {
      claim(rel, c.id)
      once.push([rel, content])
    }
    for (const [rel, content] of Object.entries(c.shipped)) {
      claim(rel, c.id)
      shipped.push([rel, content])
    }
  }
  return { once, shipped, merged }
}

/** The shipped files of every contribution, for `holi skills update`. */
export function shippedFiles(contributions: readonly SeedContribution[]): [string, string][] {
  return tables(contributions).shipped
}

/**
 * Run every merged file's merge and write what changed. `has` answers for the
 * disk, plus whatever `pending` says this run is about to write.
 */
export async function runMerges(
  root: string,
  contributions: readonly SeedContribution[],
  pending: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const written: string[] = []
  const has = async (rel: string) => pending.has(rel) || (await exists(root, rel))
  for (const [rel, merge] of tables(contributions).merged) {
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    const next = await merge(onDisk, has)
    if (next === null) continue
    await writeAtomic(root, vaultRelPath(rel), next)
    written.push(rel)
  }
  return written
}

/**
 * Idempotent, and run on creation, adoption and every open. Three rules:
 *
 *   - **merged** files first, in contribution order, so core's `.gitignore`
 *     is in place before anything that could be committed is written: until
 *     it exists nothing stops `git add -A` from taking a machine-local file.
 *   - **once**: created if absent, never touched again.
 *   - **shipped**: written **only when the vault is being created**, told by
 *     `.holi/vault` not existing yet, and recorded so a later
 *     `holi skills update` has a base to merge against. An open never writes
 *     one, so a skill the vault deleted stays deleted.
 */
export async function ensureSeeded(
  root: string,
  contributions: readonly SeedContribution[],
): Promise<SeedResult> {
  const { once, shipped } = tables(contributions)
  // Read before the once files below write it.
  const creating = !(await exists(root, VAULT_MARKER_FILE))
  const toShip = new Set(creating ? shipped.map(([rel]) => rel) : [])

  const written = await runMerges(root, contributions, toShip)

  for (const [rel, content] of once) {
    if (await exists(root, rel)) continue
    await writeAtomic(root, vaultRelPath(rel), content)
    written.push(rel)
  }

  if (creating) {
    for (const [rel, content] of shipped) {
      if (await exists(root, rel)) continue
      await writeAtomic(root, vaultRelPath(rel), content)
      await recordSeeded(root, rel, content)
      written.push(rel)
    }
  }
  return { written }
}
