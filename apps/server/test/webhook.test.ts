import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encryptionKey, seal } from '../src/crypto'
import { vaultGit } from '../src/db/schema'
import { makeGithubWebhookHandler } from '../src/git/webhook'
import { createTestDb, type TestDb } from '../src/test/db'
import { seedUser, seedVault } from '../src/test/fixtures'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(() => t.destroy())

function makeReqRes(body: string, headers: Record<string, string>) {
  const chunks = [Buffer.from(body)]
  const req = {
    headers,
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
  const res = { statusCode: 0, ended: false, end(_?: string) { this.ended = true } }
  return { req: req as never, res: res as never, raw: res }
}

async function seedGitVault(secret: string, repoUrl = 'https://github.com/o/r') {
  const user = await seedUser(t.db)
  const vault = await seedVault(t.db, user.id)
  const key = encryptionKey()
  await t.db.insert(vaultGit).values({
    vaultId: vault.id,
    repoUrl,
    remote: '/tmp/unused',
    defaultBranch: 'main',
    deployKeyCiphertext: seal('k', key),
    deployKeyPublic: 'p',
    webhookSecretCiphertext: seal(secret, key),
    enabledBy: user.id,
  })
  return vault
}

function sign(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

describe('github webhook', () => {
  it('valid signature → 202 and triggers a sync for the matching vault', async () => {
    const vault = await seedGitVault('s3cret')
    const synced: string[] = []
    const handler = makeGithubWebhookHandler({ db: t.db, triggerSync: async (id) => void synced.push(id) })
    const body = JSON.stringify({ repository: { full_name: 'o/r' } })
    const { req, res, raw } = makeReqRes(body, {
      'x-github-event': 'push',
      'x-hub-signature-256': sign('s3cret', body),
    })
    await handler(req, res)
    expect((raw as { statusCode: number }).statusCode).toBe(202)
    await vi.waitFor(() => expect(synced).toEqual([vault.id]))
  })

  it('bad signature → 401, no sync', async () => {
    await seedGitVault('right', 'https://github.com/o/r2')
    const synced: string[] = []
    const handler = makeGithubWebhookHandler({ db: t.db, triggerSync: async (id) => void synced.push(id) })
    const body = JSON.stringify({ repository: { full_name: 'o/r2' } })
    const { req, res, raw } = makeReqRes(body, {
      'x-github-event': 'push',
      'x-hub-signature-256': sign('wrong', body),
    })
    await handler(req, res)
    expect((raw as { statusCode: number }).statusCode).toBe(401)
    expect(synced).toEqual([])
  })

  it('ping event with a valid signature → 204', async () => {
    await seedGitVault('pingsec', 'https://github.com/o/r3')
    const handler = makeGithubWebhookHandler({ db: t.db, triggerSync: async () => {} })
    const body = JSON.stringify({ zen: 'x', repository: { full_name: 'o/r3' } })
    const { req, res, raw } = makeReqRes(body, {
      'x-github-event': 'ping',
      'x-hub-signature-256': sign('pingsec', body),
    })
    await handler(req, res)
    expect((raw as { statusCode: number }).statusCode).toBe(204)
  })

  it('unknown repository → 404', async () => {
    const handler = makeGithubWebhookHandler({ db: t.db, triggerSync: async () => {} })
    const body = JSON.stringify({ repository: { full_name: 'nobody/nothing' } })
    const { req, res, raw } = makeReqRes(body, {
      'x-github-event': 'push',
      'x-hub-signature-256': 'sha256=deadbeef',
    })
    await handler(req, res)
    expect((raw as { statusCode: number }).statusCode).toBe(404)
  })
})
