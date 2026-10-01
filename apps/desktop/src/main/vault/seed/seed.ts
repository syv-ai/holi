/**
 * Write what a vault must have, from every part of Holi that seeds one (each a
 * `SeedContribution`: core, the agent, PDF).
 *
 * **Seeding runs on vault creation, adoption AND every open**, but what an open
 * may do is narrow. Shipped files (skills, hooks) are written only when the
 * vault is created, or when a plugin is turned on: after that they are the
 * vault's, and a newer version reaches them only through `holi skills update`
 * (`update.ts`).
 *
 * `USER.local.md` is deliberately NOT seeded: it is machine-local (its name
 * says so), and the agent creates it when it first learns something about the
 * user.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { vaultRelPath, VAULT_MARKER_FILE } from '@holi/shared'
import { writeAtomic } from '../vault-files'
import { readSeedState, recordPlugins, recordSeeded } from './state'
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
  /** Path, text, and the id it is seeded under (`seedId`). */
  const shipped: [string, string, string][] = []
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
      shipped.push([rel, content, seedId(contributions, c, rel)])
    }
  }
  return { once, shipped, merged }
}

const under = (rel: string, prefixes: readonly string[] | undefined): boolean =>
  prefixes?.some((prefix) => rel.startsWith(prefix)) ?? false

/**
 * The id a file is seeded under: its contribution's, or `<id>@<owner>` for a
 * file under a prefix another contribution owns (`google@agent`), so turning
 * the owner on later is told apart in the seed state like turning on a plugin.
 */
function seedId(
  contributions: readonly SeedContribution[],
  c: SeedContribution,
  rel: string,
): string {
  const owner = contributions.find((o) => o !== c && under(rel, o.owns))
  return owner === undefined ? c.id : `${c.id}@${owner.id}`
}

/**
 * `contributions` without what they seed under `prefixes`, the prefixes of
 * owners that are off: files and fragments both.
 */
export function withoutOwned(
  contributions: readonly SeedContribution[],
  prefixes: readonly string[],
): SeedContribution[] {
  if (prefixes.length === 0) return [...contributions]
  const keep = <T>(table: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(table).filter(([rel]) => !under(rel, prefixes)))
  return contributions.map((c) => ({
    ...c,
    once: keep(c.once),
    shipped: keep(c.shipped),
    ...(c.fragments === undefined ? {} : { fragments: keep(c.fragments) }),
  }))
}

/** The shipped files of every contribution, for `holi skills update`. */
export function shippedFiles(contributions: readonly SeedContribution[]): [string, string][] {
  return tables(contributions).shipped.map(([rel, content]) => [rel, content])
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
    const fragments = contributions.flatMap((c) => c.fragments?.[rel] ?? [])
    const onDisk = await readFile(join(root, rel), 'utf8').catch(() => null)
    const next = await merge(onDisk, fragments, has)
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
 *   - **shipped**: written **when the vault is being created**, told by
 *     `.holi/vault` not existing yet, and recorded so a later
 *     `holi skills update` has a base to merge against. An open never writes
 *     one, so a skill the vault deleted stays deleted.
 *
 * `plugins` names the enabled plugins, whose contributions carry their ids.
 * A plugin's shipped files are also written on an open where it is enabled
 * for the first time on this machine, told by the plugin baseline in the
 * seed state. The first open of a clone on a machine has no baseline yet,
 * and only records one: the vault already has whatever its plugins seeded.
 * Another contribution's files under an owned prefix (`owns`) count as
 * their own entry, `<id>@<owner>`, so they are written once when the owner
 * is turned on.
 */
export async function ensureSeeded(
  root: string,
  contributions: readonly SeedContribution[],
  plugins: readonly string[] = [],
): Promise<SeedResult> {
  const { once, shipped } = tables(contributions)
  // Read before the once files below write it.
  const creating = !(await exists(root, VAULT_MARKER_FILE))
  const baseline = (await readSeedState(root)).plugins
  // A plugin, or another's files under a prefix a plugin owns (`seedId`).
  const ids = [...plugins, ...shipped.map(([, , id]) => id).filter((id) => id.includes('@'))]
  const turnedOn = new Set(
    creating || baseline === undefined ? [] : ids.filter((id) => !baseline.includes(id)),
  )
  const toShip = shipped.filter(([, , id]) => creating || turnedOn.has(id))

  const written = await runMerges(root, contributions, new Set(toShip.map(([rel]) => rel)))

  for (const [rel, content] of once) {
    if (await exists(root, rel)) continue
    await writeAtomic(root, vaultRelPath(rel), content)
    written.push(rel)
  }

  for (const [rel, content] of toShip) {
    if (await exists(root, rel)) continue
    await writeAtomic(root, vaultRelPath(rel), content)
    await recordSeeded(root, rel, content)
    written.push(rel)
  }

  // Only ever grows: a plugin turned off and on again is not new here.
  const seen = [...new Set([...(baseline ?? []), ...ids])]
  if (baseline === undefined || seen.length > baseline.length) await recordPlugins(root, seen)
  return { written }
}
