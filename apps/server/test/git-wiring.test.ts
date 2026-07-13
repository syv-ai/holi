import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, seal } from '../src/crypto'
import { githubConnections, vaultGit } from '../src/db/schema'
import { connectRepo, disconnectRepo } from '../src/routers/git'
import { createTestDb, type TestDb } from '../src/test/db'
import { fakeGithubApi, initBareRepo } from '../src/test/git'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
const cleanups: string[] = []
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(async () => {
  await t.destroy()
  for (const d of cleanups) await rm(d, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'holi-wire-'))
  cleanups.push(dir)
  return dir
}

async function linkGithub(userId: string): Promise<void> {
  await t.db.insert(githubConnections).values({
    userId,
    githubUserId: 1,
    githubLogin: 'owner',
    tokenCiphertext: seal('gho_owner', encryptionKey()),
  })
}

describe('connectRepo', () => {
  it('wires deploy key + webhook via the API and runs the initial sync', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    await linkGithub(user.id)
    const dir = await scratch()
    const bare = await initBareRepo(join(dir, 'remote.git'))
    const api = fakeGithubApi()

    await connectRepo(
      { db: t.db, getLiveDoc: () => null, api, publicBaseUrl: 'https://holi.syv.ai', mirrorDir: join(dir, 'm') },
      { vaultId: vault.id, userId: user.id, repoUrl: 'https://github.com/syv-ai/vault-x', makeRemote: () => bare },
    )

    expect(api.deployKeys).toHaveLength(1)
    expect(api.deployKeys[0]!.key).toMatch(/^ssh-ed25519 /)
    expect(api.webhooks).toHaveLength(1)
    expect(api.webhooks[0]!.url).toBe('https://holi.syv.ai/webhooks/github')

    const [row] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row).toBeDefined()
    expect(row!.status).toBe('ok')
    expect(row!.deployKeyId).toBe(api.deployKeys[0]!.id)
    expect(row!.webhookId).toBe(api.webhooks[0]!.id)
    expect(row!.baseCommit).toMatch(/^[0-9a-f]{40}$/) // initial export ran
  })

  it('refuses without a linked GitHub account / without admin access / when already connected', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const dir = await scratch()
    const base = {
      db: t.db,
      getLiveDoc: () => null,
      api: fakeGithubApi(),
      publicBaseUrl: 'https://x',
      mirrorDir: join(dir, 'm'),
    }
    const args = { vaultId: vault.id, userId: user.id, repoUrl: 'https://github.com/o/r' }

    await expect(connectRepo(base, args)).rejects.toThrow(/link.*github/i)

    await linkGithub(user.id)
    await expect(
      connectRepo({ ...base, api: fakeGithubApi({ getRepo: async () => ({ defaultBranch: 'main', admin: false }) }) }, args),
    ).rejects.toThrow(/admin/i)

    const bare = await initBareRepo(join(dir, 'remote.git'))
    await connectRepo(base, { ...args, makeRemote: () => bare })
    await expect(connectRepo(base, { ...args, makeRemote: () => bare })).rejects.toThrow(/already/i)
  })
})

describe('disconnectRepo', () => {
  it('removes the GitHub resources, the row, and the mirror clone', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    await linkGithub(user.id)
    const dir = await scratch()
    const bare = await initBareRepo(join(dir, 'remote.git'))
    const api = fakeGithubApi()
    const deps = { db: t.db, getLiveDoc: () => null, api, publicBaseUrl: 'https://x', mirrorDir: join(dir, 'm') }
    await connectRepo(deps, { vaultId: vault.id, userId: user.id, repoUrl: 'https://github.com/o/r', makeRemote: () => bare })

    await disconnectRepo(deps, { vaultId: vault.id, userId: user.id })
    expect(api.deployKeys).toHaveLength(0)
    expect(api.webhooks).toHaveLength(0)
    expect(await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))).toHaveLength(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(dir, 'm', vault.id))).toBe(false)
  })
})
