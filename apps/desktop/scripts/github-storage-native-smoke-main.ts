import { app, safeStorage } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { GitHubSession } from '../src/main/github/session'
import { TokenStore } from '../src/main/github/token-store'

const root = process.env.HOLI_STORAGE_ROOT
const mode = process.env.HOLI_STORAGE_MODE
const secret = 'holi-native-fixture-token-never-valid'

if (!root || !mode) throw new Error('native credential fixture configuration is missing')

app.setPath('userData', join(root, 'electron-profile'))
app.commandLine.appendSwitch('disable-gpu')

const file = join(root, 'github-auth.enc')
const requests: string[] = []
const responses: Record<string, object> = {
  '/login/device/code': {
    device_code: 'synthetic-device-code',
    user_code: 'FIXTURE-CODE',
    verification_uri: 'https://github.com/login/device',
    expires_in: 600,
    interval: 1,
  },
  '/login/oauth/access_token': {
    access_token: secret,
    token_type: 'bearer',
    scope: 'repo,read:user,read:org',
  },
  '/user': {
    id: 330,
    login: 'synthetic-fixture-user',
    name: 'Synthetic fixture',
    avatar_url: 'https://example.invalid/avatar',
  },
}
const fetch = async (input: string | URL | Request): Promise<Response> => {
  const pathname = new URL(String(input)).pathname
  requests.push(pathname)
  const body = responses[pathname]
  if (!body) throw new Error('unexpected fixture network request')
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

app
  .whenReady()
  .then(async () => {
    const result: Record<string, unknown> = {
      mode,
      electron: process.versions.electron,
      platform: process.platform,
      backend: safeStorage.getSelectedStorageBackend(),
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      phases: ['app-ready', 'availability-checked'],
    }
    try {
      const store = new TokenStore(file, safeStorage)
      const session = await GitHubSession.load({
        store,
        fetch,
        sleep: async () => {},
        now: () => 0,
      })
      if (mode === 'sign-in') {
        const flow = await session.signIn()
        try {
          result.outcome = (await flow.wait()).kind
        } catch (error) {
          const storageError = error as Error & { phase?: string; backend?: string }
          result.error =
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  phase: storageError.phase,
                  backend: storageError.backend,
                }
              : { name: 'Error' }
        }
      }
      result.requests = requests
      result.hasToken = session.token() !== null
      result.hasViewer = session.viewer !== null
      result.fileExists = await stat(file).then(
        () => true,
        () => false,
      )
      if (result.fileExists) {
        const data = await readFile(file, 'utf8')
        const envelope = JSON.parse(data) as { data?: string }
        result.fileMode = (await stat(file)).mode & 0o777
        result.rawSecret = data.includes(secret)
        result.decodedSecret =
          typeof envelope.data === 'string' &&
          Buffer.from(envelope.data, 'base64').includes(Buffer.from(secret))
      }
      if (mode === 'restore') result.restoredViewer = session.viewer?.accountId === 330
      result.phases = [...(result.phases as string[]), 'session-checked']
      console.log(`HOLI_STORAGE_RESULT ${JSON.stringify(result)}`)
      app.exit(0)
    } catch (error) {
      console.log(
        `HOLI_STORAGE_RESULT ${JSON.stringify({ ...result, fatal: error instanceof Error ? error.name : 'Error' })}`,
      )
      app.exit(2)
    }
  })
  .catch(() => app.exit(2))
