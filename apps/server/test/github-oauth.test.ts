import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptionKey, openSealed } from '../src/crypto'
import { createGithubOAuth } from '../src/git/oauth'
import { githubConnections } from '../src/db/schema'
import { createTestDb, type TestDb } from '../src/test/db'
import { fakeGithubApi } from '../src/test/git'
import { seedUser } from '../src/test/fixtures'

let t: TestDb
beforeAll(async () => {
  t = await createTestDb()
})
afterAll(() => t.destroy())

describe('github oauth linking', () => {
  it('authorize URL carries client id + state; callback stores the encrypted token', async () => {
    const user = await seedUser(t.db)
    const api = fakeGithubApi({
      exchangeCode: async (code) => {
        expect(code).toBe('code-123')
        return { accessToken: 'gho_linked' }
      },
      getUser: async () => ({ id: 4242, login: 'nicolai' }),
    })
    const oauth = createGithubOAuth({ db: t.db, api, clientId: 'cid', publicBaseUrl: 'http://127.0.0.1:4000' })

    const url = new URL(oauth.authorizeUrl(user.id))
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('scope')).toBe('repo admin:repo_hook')
    const state = url.searchParams.get('state')!
    expect(state.length).toBeGreaterThan(10)

    const html = await oauth.handleCallback({ code: 'code-123', state })
    expect(html).toContain('GitHub connected')

    const [row] = await t.db.select().from(githubConnections).where(eq(githubConnections.userId, user.id))
    expect(row!.githubLogin).toBe('nicolai')
    expect(row!.githubUserId).toBe(4242)
    expect(openSealed(row!.tokenCiphertext, encryptionKey())).toBe('gho_linked')
  })

  it('re-linking overwrites the existing connection', async () => {
    const user = await seedUser(t.db)
    const oauth = createGithubOAuth({
      db: t.db,
      api: fakeGithubApi({ getUser: async () => ({ id: 1, login: 'first' }) }),
      clientId: 'cid',
      publicBaseUrl: 'http://x',
    })
    await oauth.handleCallback({ code: 'c', state: new URL(oauth.authorizeUrl(user.id)).searchParams.get('state')! })
    const oauth2 = createGithubOAuth({
      db: t.db,
      api: fakeGithubApi({ getUser: async () => ({ id: 2, login: 'second' }) }),
      clientId: 'cid',
      publicBaseUrl: 'http://x',
    })
    await oauth2.handleCallback({ code: 'c', state: new URL(oauth2.authorizeUrl(user.id)).searchParams.get('state')! })
    const [row] = await t.db.select().from(githubConnections).where(eq(githubConnections.userId, user.id))
    expect(row!.githubLogin).toBe('second')
  })

  it('rejects an unknown or reused state', async () => {
    const user = await seedUser(t.db)
    const oauth = createGithubOAuth({ db: t.db, api: fakeGithubApi(), clientId: 'cid', publicBaseUrl: 'http://x' })
    await expect(oauth.handleCallback({ code: 'c', state: 'bogus' })).rejects.toThrow(/state/i)
    const state = new URL(oauth.authorizeUrl(user.id)).searchParams.get('state')!
    await oauth.handleCallback({ code: 'c', state })
    await expect(oauth.handleCallback({ code: 'c', state })).rejects.toThrow(/state/i)
  })
})
