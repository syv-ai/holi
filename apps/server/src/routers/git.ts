/** Vault-level git-mirror wiring + status. Owner-only mutations; the owner's
 * linked GitHub token is used ONLY here (wiring/un-wiring) — background sync
 * runs on the deploy key (design spec §Wiring). */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { encryptionKey, openSealed, seal } from '../crypto'
import type { Db } from '../db/client'
import { githubConnections, vaultGit } from '../db/schema'
import type { GithubApi } from '../git/github-api'
import { parseGithubRepoUrl, sshRemote, type GithubRepo } from '../git/repo-url'
import { cloneDirFor, syncVault, withVaultLock } from '../git/sync'
import type { GetLiveDoc } from '../trpc'
import { ownerProcedure, router, vaultProcedure } from '../trpc'

const run = promisify(execFile)

export interface GitWiringDeps {
  db: Db
  getLiveDoc: GetLiveDoc
  api: GithubApi
  publicBaseUrl: string
  /** Test override — production uses config.git.mirrorDir via sync.ts default. */
  mirrorDir?: string
}

async function ownerGithubToken(db: Db, userId: string): Promise<string> {
  const [conn] = await db.select().from(githubConnections).where(eq(githubConnections.userId, userId))
  if (!conn)
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'link your GitHub account first (app settings)' })
  return openSealed(conn.tokenCiphertext, encryptionKey())
}

/** ed25519 keypair via ssh-keygen (already required for pushes; no native deps). */
async function generateDeployKey(comment: string): Promise<{ privateKey: string; publicKey: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-keygen-'))
  try {
    await run('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', join(dir, 'key')])
    return {
      privateKey: await readFile(join(dir, 'key'), 'utf8'),
      publicKey: (await readFile(join(dir, 'key.pub'), 'utf8')).trim(),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function connectRepo(
  deps: GitWiringDeps,
  args: { vaultId: string; userId: string; repoUrl: string; makeRemote?: (r: GithubRepo) => string },
): Promise<void> {
  const { db } = deps
  const [existing] = await db.select().from(vaultGit).where(eq(vaultGit.vaultId, args.vaultId))
  if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'this vault is already connected to a repo' })

  const token = await ownerGithubToken(db, args.userId)
  const repo = parseGithubRepoUrl(args.repoUrl)
  const info = await deps.api.getRepo(token, repo.owner, repo.repo)
  if (!info.admin)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'you need admin access to that repository' })

  const keys = await generateDeployKey(`holi-vault-${args.vaultId}`)
  const deployKey = await deps.api.createDeployKey(token, repo.owner, repo.repo, 'Holi vault mirror', keys.publicKey)
  const webhookSecret = randomBytes(24).toString('hex')
  const webhook = await deps.api.createWebhook(
    token,
    repo.owner,
    repo.repo,
    `${deps.publicBaseUrl}/webhooks/github`,
    webhookSecret,
  )

  const key = encryptionKey()
  await db.insert(vaultGit).values({
    vaultId: args.vaultId,
    repoUrl: args.repoUrl,
    remote: (args.makeRemote ?? sshRemote)(repo),
    defaultBranch: info.defaultBranch,
    deployKeyCiphertext: seal(keys.privateKey, key),
    deployKeyPublic: keys.publicKey,
    deployKeyId: deployKey.id,
    webhookId: webhook.id,
    webhookSecretCiphertext: seal(webhookSecret, key),
    enabledBy: args.userId,
  })

  await syncVault({ db, getLiveDoc: deps.getLiveDoc, mirrorDir: deps.mirrorDir }, args.vaultId)
  const [row] = await db.select().from(vaultGit).where(eq(vaultGit.vaultId, args.vaultId))
  if (row?.status === 'attention') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `connected, but the first sync failed: ${row.statusDetail}` })
  }
}

export async function disconnectRepo(deps: GitWiringDeps, args: { vaultId: string; userId: string }): Promise<void> {
  const { db } = deps
  const [row] = await db.select().from(vaultGit).where(eq(vaultGit.vaultId, args.vaultId))
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'no repo connected' })
  // best-effort GitHub cleanup — the row and clone go away regardless
  try {
    const token = await ownerGithubToken(db, args.userId)
    const repo = parseGithubRepoUrl(row.repoUrl)
    if (row.deployKeyId) await deps.api.deleteDeployKey(token, repo.owner, repo.repo, row.deployKeyId)
    if (row.webhookId) await deps.api.deleteWebhook(token, repo.owner, repo.repo, row.webhookId)
  } catch (err) {
    console.warn('[git] best-effort GitHub cleanup failed:', err)
  }
  await withVaultLock(args.vaultId, async () => {
    await db.delete(vaultGit).where(eq(vaultGit.vaultId, args.vaultId))
    await rm(cloneDirFor({ db, getLiveDoc: deps.getLiveDoc, mirrorDir: deps.mirrorDir }, args.vaultId), {
      recursive: true,
      force: true,
    })
  })
}

export function makeGitRouter(deps: Omit<GitWiringDeps, 'db' | 'getLiveDoc'>) {
  return router({
    status: vaultProcedure.query(async ({ ctx }) => {
      const [row] = await ctx.db.select().from(vaultGit).where(eq(vaultGit.vaultId, ctx.vaultId))
      if (!row) return null
      return {
        repoUrl: row.repoUrl,
        defaultBranch: row.defaultBranch,
        status: row.status,
        statusDetail: row.statusDetail,
        warnings: row.warnings,
        lastExportAt: row.lastExportAt,
        lastIngestAt: row.lastIngestAt,
      }
    }),

    connectRepo: ownerProcedure.input(z.object({ repoUrl: z.string() })).mutation(({ ctx, input }) =>
      connectRepo(
        { ...deps, db: ctx.db, getLiveDoc: ctx.getLiveDoc },
        { vaultId: ctx.vaultId, userId: ctx.user.id, repoUrl: input.repoUrl },
      ),
    ),

    disconnectRepo: ownerProcedure.mutation(({ ctx }) =>
      disconnectRepo({ ...deps, db: ctx.db, getLiveDoc: ctx.getLiveDoc }, { vaultId: ctx.vaultId, userId: ctx.user.id }),
    ),

    syncNow: vaultProcedure.mutation(async ({ ctx }) => {
      await syncVault({ db: ctx.db, getLiveDoc: ctx.getLiveDoc, mirrorDir: deps.mirrorDir }, ctx.vaultId)
      return { ok: true }
    }),
  })
}
