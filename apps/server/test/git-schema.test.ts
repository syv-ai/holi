import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, openSealed, seal } from '../src/crypto'
import { githubConnections, vaultGit } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(() => t.destroy())

describe('git schema', () => {
  it('stores a github connection with an encrypted token', async () => {
    const user = await seedUser(t.db)
    const key = encryptionKey()
    await t.db.insert(githubConnections).values({
      userId: user.id,
      githubUserId: 12345,
      githubLogin: 'nicolai',
      tokenCiphertext: seal('gho_token', key),
    })
    const [row] = await t.db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.userId, user.id))
    expect(row!.githubLogin).toBe('nicolai')
    expect(openSealed(row!.tokenCiphertext, key)).toBe('gho_token')
  })

  it('stores vault_git with defaults and cascades on vault delete', async () => {
    const user = await seedUser(t.db)
    const vault = await seedVault(t.db, user.id)
    const key = encryptionKey()
    await t.db.insert(vaultGit).values({
      vaultId: vault.id,
      repoUrl: 'https://github.com/syv-ai/vault-x',
      remote: 'git@github.com:syv-ai/vault-x.git',
      defaultBranch: 'main',
      deployKeyCiphertext: seal('PRIVATE KEY', key),
      deployKeyPublic: 'ssh-ed25519 AAAA...',
      webhookSecretCiphertext: seal('whsec', key),
      enabledBy: user.id,
    })
    const [row] = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(row!.status).toBe('ok')
    expect(row!.baseCommit).toBeNull()
    expect(row!.warnings).toEqual([])

    const { vaults } = await import('../src/db/schema')
    await t.db.delete(vaults).where(eq(vaults.id, vault.id))
    const rows = await t.db.select().from(vaultGit).where(eq(vaultGit.vaultId, vault.id))
    expect(rows).toHaveLength(0)
  })
})
