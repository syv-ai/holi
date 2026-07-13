/** The per-vault sync loop: fetch → detect force-push → ingest foreign commits
 * → export → push (retrying through non-fast-forwards). Exactly one git writer
 * per vault, enforced by withVaultLock. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { config } from '../config'
import { encryptionKey, openSealed } from '../crypto'
import type { Db } from '../db/client'
import { vaultGit, type GitWarning } from '../db/schema'
import type { GetLiveDoc } from '../trpc'
import { exportCommit } from './exporter'
import { git, isAncestor, tryGit, type GitEnv } from './git'
import { ingestRange } from './ingester'

const MAX_PUSH_RETRIES = 5
const MAX_WARNINGS_KEPT = 50

export interface SyncDeps {
  db: Db
  getLiveDoc: GetLiveDoc
  /** Override for tests; defaults to config.git.mirrorDir. */
  mirrorDir?: string
}

/* ---------- per-vault serialization ---------- */

const chains = new Map<string, Promise<unknown>>()

export function withVaultLock<T>(vaultId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(vaultId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  chains.set(
    vaultId,
    next.catch(() => undefined),
  )
  return next
}

/* ---------- clone + remote-auth plumbing ---------- */

export function cloneDirFor(deps: SyncDeps, vaultId: string): string {
  return join(deps.mirrorDir ?? config.git.mirrorDir, vaultId)
}

/** ssh remotes get GIT_SSH_COMMAND pointing at a 0600 temp copy of the deploy
 * key; filesystem remotes (tests) need nothing. Callers must invoke cleanup. */
async function remoteEnv(row: typeof vaultGit.$inferSelect): Promise<{ env: GitEnv; cleanup: () => Promise<void> }> {
  if (!row.remote.includes('@')) return { env: {}, cleanup: async () => {} }
  const dir = await mkdtemp(join(tmpdir(), 'holi-key-'))
  const keyFile = join(dir, 'key')
  await writeFile(keyFile, openSealed(row.deployKeyCiphertext, encryptionKey()) + '\n', { mode: 0o600 })
  return {
    env: { GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function ensureClone(deps: SyncDeps, row: typeof vaultGit.$inferSelect, env: GitEnv): Promise<string> {
  const dir = cloneDirFor(deps, row.vaultId)
  const probe = await tryGit(['rev-parse', '--git-dir'], dir).catch(() => ({ ok: false as const, error: 'no dir' }))
  if (probe.ok) return dir
  await mkdir(dir, { recursive: true })
  await git(['init', `--initial-branch=${row.defaultBranch}`, '.'], dir)
  await git(['remote', 'add', 'origin', row.remote], dir)
  const fetched = await tryGit(['fetch', 'origin'], dir, env)
  if (!fetched.ok) throw new Error(`cannot reach remote: ${fetched.error}`)
  return dir
}

/* ---------- status/warning bookkeeping ---------- */

async function setAttention(db: Db, vaultId: string, detail: string): Promise<void> {
  await db
    .update(vaultGit)
    .set({ status: 'attention', statusDetail: detail, updatedAt: new Date() })
    .where(eq(vaultGit.vaultId, vaultId))
}

async function appendWarnings(db: Db, vaultId: string, warnings: GitWarning[]): Promise<void> {
  if (warnings.length === 0) return
  await db
    .update(vaultGit)
    .set({
      warnings: sql`(
        select coalesce(jsonb_agg(w), '[]'::jsonb) from (
          select w from jsonb_array_elements(${vaultGit.warnings} || ${JSON.stringify(warnings)}::jsonb) as w
          order by w->>'at' desc limit ${MAX_WARNINGS_KEPT}
        ) sub
      )`,
      updatedAt: new Date(),
    })
    .where(eq(vaultGit.vaultId, vaultId))
}

/* ---------- the sync pass ---------- */

async function syncPass(deps: SyncDeps, vaultId: string): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(vaultGit).where(eq(vaultGit.vaultId, vaultId))
  if (!row || row.status !== 'ok') return

  const { env, cleanup } = await remoteEnv(row)
  try {
    const cloneDir = await ensureClone(deps, row, env)
    await tryGit(['fetch', 'origin'], cloneDir, env)
    await db.update(vaultGit).set({ lastFetchAt: new Date() }).where(eq(vaultGit.vaultId, vaultId))

    const remoteHead = await tryGit(['rev-parse', `origin/${row.defaultBranch}`], cloneDir)
    let base = row.baseCommit

    // ----- inbound -----
    if (remoteHead.ok) {
      const head = remoteHead.stdout
      if (base && head !== base) {
        if (!(await isAncestor(cloneDir, base, head))) {
          await setAttention(db, vaultId, `remote history was rewritten (force-push); re-connect or re-baseline`)
          return
        }
        const authors = await git(['log', '--format=%ae', `${base}..${head}`], cloneDir)
        const foreign = authors.split('\n').some((a) => a !== '' && a !== config.git.botEmail)
        if (foreign) {
          const warnings = await ingestRange(deps, vaultId, cloneDir, base, head)
          await appendWarnings(db, vaultId, warnings)
          await db.update(vaultGit).set({ lastIngestAt: new Date() }).where(eq(vaultGit.vaultId, vaultId))
        }
        base = head
      } else if (!base) {
        // first sync against a non-empty repo: repo-only files ingest as adds
        // (diff against git's empty tree); colliding paths are vault-wins —
        // skipExisting leaves them untouched and the export below overwrites
        // them on the remote, with the repo's version preserved in history.
        const emptyTree = await git(['hash-object', '-t', 'tree', '/dev/null'], cloneDir)
        const warnings = await ingestRange(deps, vaultId, cloneDir, emptyTree, head, { skipExisting: true })
        await appendWarnings(db, vaultId, warnings)
        base = head
      }
      await git(['checkout', '-B', row.defaultBranch, head], cloneDir)
    } else {
      // empty remote (unborn branch) — nothing to ingest
      await tryGit(['checkout', '-B', row.defaultBranch], cloneDir)
    }

    // ----- outbound (with non-fast-forward retry loop) -----
    for (let attempt = 0; attempt < MAX_PUSH_RETRIES; attempt++) {
      const sha = await exportCommit(db, vaultId, cloneDirFor(deps, vaultId))
      const target = sha ?? base
      if (sha) {
        const pushed = await tryGit(['push', '-u', 'origin', row.defaultBranch], cloneDirFor(deps, vaultId), env)
        if (!pushed.ok) {
          // someone pushed between our fetch and push: take their commits, retry
          await git(['fetch', 'origin'], cloneDirFor(deps, vaultId), env)
          const head = await git(['rev-parse', `origin/${row.defaultBranch}`], cloneDirFor(deps, vaultId))
          if (base && !(await isAncestor(cloneDirFor(deps, vaultId), base, head))) {
            await setAttention(db, vaultId, 'remote history was rewritten during push')
            return
          }
          if (base) {
            const warnings = await ingestRange(deps, vaultId, cloneDirFor(deps, vaultId), base, head)
            await appendWarnings(db, vaultId, warnings)
          }
          base = head
          await git(['checkout', '-B', row.defaultBranch, head], cloneDirFor(deps, vaultId))
          continue
        }
        await db
          .update(vaultGit)
          .set({ baseCommit: sha, lastExportAt: new Date(), statusDetail: null, updatedAt: new Date() })
          .where(eq(vaultGit.vaultId, vaultId))
        return
      }
      // nothing to export — just advance the base if ingest moved it
      if (target !== row.baseCommit) {
        await db
          .update(vaultGit)
          .set({ baseCommit: target, updatedAt: new Date() })
          .where(eq(vaultGit.vaultId, vaultId))
      }
      return
    }
    await setAttention(db, vaultId, `push kept failing after ${MAX_PUSH_RETRIES} attempts`)
  } catch (err) {
    await setAttention(db, vaultId, err instanceof Error ? err.message : String(err))
  } finally {
    await cleanup()
  }
}

/** Public entry point — serialized per vault. */
export function syncVault(deps: SyncDeps, vaultId: string): Promise<void> {
  return withVaultLock(vaultId, () => syncPass(deps, vaultId))
}
