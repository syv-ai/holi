import { join } from 'node:path'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore } from '../src/main/github/token-store'

const auth = {
  token: 'holi-550-owned-fixture-token',
  accountId: 550001,
  login: 'holi-550-fixture',
  name: 'Holi 550 Fixture',
  avatarUrl: 'https://avatars.githubusercontent.com/u/550001?v=4',
  scopes: ['repo', 'read:user', 'read:org'],
}
const memoryEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
  decryptString: (encrypted: Buffer) => encrypted.toString('utf8'),
  getSelectedStorageBackend: () => 'unknown',
}

export async function createSession(userDataDir: string): Promise<GitHubSession> {
  const store = new TokenStore(join(userDataDir, 'github-auth.enc'), memoryEncryption)
  if (!(await store.read())) await store.write(auth)
  return GitHubSession.load({
    store,
    fetch: async (input) => {
      const url = new URL(String(input))
      if (url.origin === 'https://api.github.com' && url.pathname === '/user')
        return Response.json({
          id: auth.accountId,
          login: auth.login,
          name: auth.name,
          avatar_url: auth.avatarUrl,
        })
      throw new Error(`Unexpected fixture network request: ${url.origin}${url.pathname}`)
    },
  })
}
