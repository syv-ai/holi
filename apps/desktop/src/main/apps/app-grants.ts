/**
 * Which apps this person has let read their Google data, on this machine.
 *
 * An app opts in with `dangerously-allow: [mail]` in its `app.yaml`, the way
 * Claude Code opts into `--dangerously-skip-permissions`. The flag alone is not
 * enough for a shared app: mail and calendar are one person's, not the vault's,
 * and an app can keep what it reads in records that sync to every member, or
 * send it over the network. So each person approves it once, in a dialog Holi
 * shows before the app loads, and the approval is kept **here, in main**,
 * because the renderer is the process running the app's code.
 *
 * An approval lapses after `GRANT_TTL_MS`, and as soon as the app's code
 * changes (any file but `data/`), whoever changed it: approving a teammate's
 * app is approving that code, not whatever it becomes after the next pull.
 *
 * A personal `.local.app` needs the flag but no approval: its code was written
 * on this machine and its records never sync.
 *
 * Plain JSON in userData, like `google/calendar-prefs.ts`: no credential here.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  APP_LOG_FILE,
  APP_MANIFEST_FILE,
  DATA_DIR,
  isAppPrivatePath,
  isLocalOnlyPath,
  parseAppManifest,
  vaultRelPath,
  type AppAffordance,
  type AppManifest,
} from '@holi/shared'
import { CapabilityError } from '../capabilities/error'
import type { Admit } from '../capabilities/registry'
import { runGit } from '../git'
import { jsonFileStore } from '../json-file-store'
import { absPathFor } from '../vault/vault-files'

export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface AffordanceStatus {
  affordance: AppAffordance
  granted: boolean
}

export interface GrantStatus {
  /** The code the answer is about, to send back with an approval. */
  codeHash: string
  /** One entry per affordance the app's manifest declares. */
  affordances: AffordanceStatus[]
}

export interface AppGrants {
  status(remote: string, root: string, bundle: string): Promise<GrantStatus>
  /**
   * Approve `affordances` for the code `codeHash` names, the code the dialog
   * was shown for. False, and nothing recorded, when the code has changed
   * since (a pull landed while the dialog was up): the person is asked again.
   * Affordances the manifest does not declare are ignored: an approval never
   * widens what the app asked for.
   */
  grant(
    remote: string,
    root: string,
    bundle: string,
    affordances: string[],
    codeHash: string,
  ): Promise<boolean>
}

interface GrantRecord {
  expiresAt: number
  codeHash: string
}

type GrantFile = Record<string, GrantRecord>

/**
 * Everything the app can serve, but its records: each file's path and a hash
 * of its bytes, each symlink's path and target, every directory (records
 * aside, `node_modules` included, since the protocol serves it), in name
 * order. Each entry is framed by JSON, so no file's bytes can pass for the
 * boundary between two entries. `data/` and the log are left out because they
 * change every time the app is used, and the approval is of the code.
 */
export async function bundleCodeHash(root: string, bundle: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(root, bundle, rel), { withFileTypes: true }).catch(() => [])
    entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
    for (const e of entries) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`
      if (rel === '' && isAppPrivatePath(e.name)) continue
      const abs = join(root, bundle, path)
      if (e.isSymbolicLink()) {
        const target = await readlink(abs).catch(() => '')
        hash.update(`${JSON.stringify(['link', path, target])}\n`)
      } else if (e.isDirectory()) {
        hash.update(`${JSON.stringify(['dir', path])}\n`)
        await walk(path)
      } else {
        const bytes = await readFile(abs).catch(() => null)
        const digest =
          bytes === null ? 'unreadable' : createHash('sha256').update(bytes).digest('hex')
        hash.update(`${JSON.stringify(['file', path, digest])}\n`)
      }
    }
  }
  await walk('')
  return hash.digest('hex')
}

/**
 * A personal app skips the approval because its code was written here and never
 * syncs. A `.local.` name only says so: a teammate can `git add -f` one and
 * push it, and then it is shared code wearing a personal name. So it counts as
 * personal only while git tracks none of it. If git cannot answer, it is shared.
 */
async function isPersonal(root: string, bundle: string): Promise<boolean> {
  if (!isLocalOnlyPath(bundle)) return false
  const tracked = await runGit(root, ['ls-files', '--', bundle]).catch(() => null)
  return tracked !== null && tracked.trim() === ''
}

/** One commit to an app's code: who, which, when. */
export interface BundleCommit {
  sha: string
  author: string
  email: string
  /** ISO 8601, author date. */
  date: string
}

/**
 * The commit that added an app's code and the last one that changed it: what
 * the approval dialog names, so a person approves code they can place.
 * Records and the log are left out, as the approval's hash leaves them out:
 * they change as the app is used. Both null when no commit touches the code (a
 * personal app, never committed); the same commit when it was changed once.
 */
export async function bundleAuthorship(
  root: string,
  bundle: string,
): Promise<{ added: BundleCommit | null; last: BundleCommit | null }> {
  const out = await runGit(root, [
    'log',
    '--format=%H%x1f%an%x1f%ae%x1f%aI',
    '--',
    `:(literal)${bundle}`,
    `:(exclude,literal)${bundle}/${DATA_DIR}`,
    `:(exclude,literal)${bundle}/${APP_LOG_FILE}`,
  ]).catch(() => '')
  const commits = out
    .split('\n')
    .filter((line) => line !== '')
    .map((line): BundleCommit => {
      const [sha = '', author = '', email = '', date = ''] = line.split('\x1f')
      return { sha, author, email, date }
    })
  return { added: commits.at(-1) ?? null, last: commits[0] ?? null }
}

/**
 * The GitHub login behind a commit, or null: a GitHub noreply address says
 * it outright, and otherwise a name that is one of the vault's members'
 * logins is taken as that member (Holi commits under the machine's git
 * name, which is often the login). Nothing is guessed beyond those.
 */
export function commitLogin(commit: BundleCommit, members: readonly string[]): string | null {
  const noreply = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(commit.email)
  if (noreply !== null) return noreply[1]!
  return members.find((login) => login.toLowerCase() === commit.author.toLowerCase()) ?? null
}

/** The bundle's manifest, or null when it has none. */
export async function manifestOf(root: string, bundle: string): Promise<AppManifest | null> {
  const text = await readFile(
    absPathFor(root, vaultRelPath(`${bundle}/${APP_MANIFEST_FILE}`)),
    'utf8',
  ).catch(() => null)
  return text === null ? null : parseAppManifest(text)
}

/** The affordances the bundle's manifest declares; none when it has no manifest. */
export async function declaredAffordances(root: string, bundle: string): Promise<AppAffordance[]> {
  return (await manifestOf(root, bundle))?.dangerouslyAllow ?? []
}

const keyOf = (remote: string, bundle: string, affordance: string) =>
  JSON.stringify([remote, bundle, affordance])

/** Unwritten or corrupt: nothing is approved, which is the safe way to fail. */
function parseGrants(parsed: unknown): GrantFile {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: GrantFile = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const r = value as Partial<GrantRecord> | null
    if (typeof r?.expiresAt === 'number' && typeof r.codeHash === 'string') {
      out[key] = { expiresAt: r.expiresAt, codeHash: r.codeHash }
    }
  }
  return out
}

export function createAppGrants(path: string, now: () => number = Date.now): AppGrants {
  const store = jsonFileStore(path, parseGrants)

  return {
    async status(remote, root, bundle) {
      const [declared, codeHash] = await Promise.all([
        declaredAffordances(root, bundle),
        bundleCodeHash(root, bundle),
      ])
      if (declared.length === 0) return { codeHash, affordances: [] }
      if (await isPersonal(root, bundle)) {
        return {
          codeHash,
          affordances: declared.map((affordance) => ({ affordance, granted: true })),
        }
      }
      const file = await store.read()
      return {
        codeHash,
        affordances: declared.map((affordance) => {
          const record = file[keyOf(remote, bundle, affordance)]
          const granted =
            record !== undefined && record.expiresAt > now() && record.codeHash === codeHash
          return { affordance, granted }
        }),
      }
    },

    async grant(remote, root, bundle, affordances, shownHash) {
      const codeHash = await bundleCodeHash(root, bundle)
      if (codeHash !== shownHash) return false
      const declared = await declaredAffordances(root, bundle)
      const chosen = declared.filter((a) => affordances.includes(a))
      if (chosen.length === 0) return true
      // Queued: two approvals at once would each read the file, and the second
      // write would drop the first's record.
      await store.update((file) => {
        // Expired approvals go on every write, so the file does not only grow.
        const next = Object.fromEntries(
          Object.entries(file).filter(([, record]) => record.expiresAt > now()),
        )
        for (const affordance of chosen) {
          next[keyOf(remote, bundle, affordance)] = { expiresAt: now() + GRANT_TTL_MS, codeHash }
        }
        return next
      })
      return true
    },
  }
}

/**
 * The app door's consent check, for an entry with an `appGrant`: the app must
 * declare the affordance in `dangerously-allow`, and the person must have
 * approved it on this machine.
 */
export function admitApps(grants: AppGrants): Admit {
  return async (ctx, affordance) => {
    const bundle = ctx.bundle
    if (bundle === null) throw new CapabilityError('BAD_REQUEST', 'only an app may ask')
    const status = (await grants.status(ctx.remote, ctx.root, bundle)).affordances.find(
      (s) => s.affordance === affordance,
    )
    if (status === undefined) {
      throw new CapabilityError(
        'FORBIDDEN',
        `add "dangerously-allow: [${affordance}]" to ${bundle}/app.yaml to read ${affordance}`,
      )
    }
    if (!status.granted) {
      throw new CapabilityError(
        'FORBIDDEN',
        `reading ${affordance} is not approved on this machine`,
      )
    }
  }
}
