import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ownedFixtureDirectory } from './owned-fixture-directory'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore, type SafeStorageLike, type StoredAuth } from '../src/main/github/token-store'

const key = randomBytes(32)
const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'unknown',
  encryptString(text) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()])
  },
  decryptString(data) {
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
    cipher.setAuthTag(data.subarray(-16))
    return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString()
  },
}

export async function createFixtureSession(root: string): Promise<GitHubSession> {
  const userDataDir = ownedFixtureDirectory(root, 'user-data')
  const auth: StoredAuth = {
    token: 'holi-550-owned-fixture-token',
    accountId: 550001,
    login: 'holi-550-fixture',
    name: 'Holi 550 Fixture',
    avatarUrl: '',
    scopes: ['repo', 'read:user', 'read:org'],
  }
  const store = new TokenStore(join(userDataDir, 'github-auth.enc'), storage)
  await store.write(auth)
  return GitHubSession.load({
    store,
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.origin === 'https://api.github.com' && url.pathname === '/user')
        return Response.json({
          id: auth.accountId,
          login: auth.login,
          name: auth.name,
          avatar_url: '',
        })
      throw new Error(`Unexpected fixture network request: ${url.origin}${url.pathname}`)
    },
  })
}
