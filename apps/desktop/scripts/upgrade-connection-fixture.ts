import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { TokenStore } from '../src/main/github/token-store'
import { VaultRegistry } from '../src/main/vault/registry'
import { GoogleTokenStore } from '../src/plugins/google/main/token-store'
import { createClientStore } from '../src/plugins/google/main/credentials'
import { createGoogleAccountsManager } from '../src/plugins/google/main/electron'
import { createVaultAccounts } from '../src/plugins/google/main/vault-accounts'
import { GOOGLE_SCOPES } from '../src/plugins/google/main/session'
import { createSpeechKeyStore } from '../src/plugins/transcribe/main/speech-key'

const exec = promisify(execFile)
const fixtureToken = 'holi-upgrade-fixture-token-never-valid'
const fixtureSpeechKey = 'holi-upgrade-fixture-speech-key-never-valid'
const fixtureSub = 'holi-upgrade-fixture-google-sub'

export interface ConnectionFixtureReceipt {
  remote: string
  path: string
  userData: string
}

/** Seed encrypted fake connections and a committed local vault for an upgrade inspector. */
export async function seedConnections(
  userData: string,
  vaultRoot: string,
): Promise<ConnectionFixtureReceipt> {
  if (!app.isReady()) throw new Error('Fixture requires a ready Electron app')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Fixture requires native safeStorage encryption; no credentials were written')
  }

  const remote = `fixture-upgrade-565/${randomUUID()}`
  const clonePath = join(vaultRoot, ...remote.split('/'))
  await mkdir(userData, { recursive: true })
  await mkdir(vaultRoot, { recursive: true })

  await new TokenStore(join(userData, 'github-auth.enc'), safeStorage).write({
    token: fixtureToken,
    accountId: 565,
    login: 'holi-upgrade-fixture',
    scopes: ['repo', 'read:user', 'read:org'],
  })
  const google = new GoogleTokenStore(join(userData, 'google-auth.enc'), safeStorage)
  await google.write({
    [fixtureSub]: {
      sub: fixtureSub,
      email: 'holi-upgrade-fixture@example.invalid',
      refreshToken: 'holi-upgrade-fixture-refresh-never-valid',
      accessToken: 'holi-upgrade-fixture-access-never-valid',
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      scopes: [...GOOGLE_SCOPES],
    },
  })
  await createClientStore(join(userData, 'google-client.enc'), safeStorage).write({
    id: 'synthetic-test.apps.googleusercontent.com',
    secret: 'synthetic-fixture-secret-never-valid',
  })
  await createVaultAccounts(join(userData, 'google-vault-accounts.json')).link(remote, fixtureSub)
  await createSpeechKeyStore(join(userData, 'speech-key.enc'), safeStorage).write({
    key: fixtureSpeechKey,
    service: null,
  })

  await mkdir(clonePath, { recursive: true })
  await exec('git', ['init', '--quiet'], { cwd: clonePath })
  await exec('git', ['config', 'user.name', 'Holi Upgrade Fixture'], { cwd: clonePath })
  await exec('git', ['config', 'user.email', 'upgrade-fixture@example.invalid'], { cwd: clonePath })
  await exec('git', ['remote', 'add', 'origin', `https://github.com/${remote}.git`], {
    cwd: clonePath,
  })
  await writeFile(join(clonePath, 'README.md'), '# Upgrade fixture\n\nSynthetic local fixture.\n')
  await mkdir(join(clonePath, 'notes'), { recursive: true })
  await writeFile(join(clonePath, 'notes', 'fixture.md'), '# Upgrade fixture note\n')
  await mkdir(join(clonePath, '.holi', 'settings'), { recursive: true })
  await writeFile(
    join(clonePath, '.holi/settings/plugins.yaml'),
    'plugins:\n  google: true\n  transcribe: true\n',
  )
  await exec('git', ['add', '.'], { cwd: clonePath })
  await exec('git', ['commit', '--quiet', '-m', 'seed upgrade fixture'], { cwd: clonePath })

  const openedAt = new Date().toISOString()
  await new VaultRegistry(join(userData, 'vaults.json')).add({
    remote,
    path: clonePath,
    name: 'Upgrade fixture',
    lastOpenedAt: openedAt,
  })

  return { remote, path: clonePath, userData }
}

/** Readers executed inside the updated Electron return fixture decryption compatibility outcomes. */
export async function inspectConnections(userData: string, remote: string) {
  if (!app.isReady() || !safeStorage.isEncryptionAvailable()) {
    throw new Error('Native credential inspection is unavailable')
  }
  const github = await new TokenStore(join(userData, 'github-auth.enc'), safeStorage).read()
  const google = await createGoogleAccountsManager(userData)
  const overview = await google.overview(remote)
  const client = await createClientStore(join(userData, 'google-client.enc'), safeStorage).read()
  const speech = await createSpeechKeyStore(join(userData, 'speech-key.enc'), safeStorage).read()
  return {
    github: github?.token === fixtureToken && github.accountId === 565,
    google: overview.state === 'connected' && overview.account?.sub === fixtureSub,
    client:
      client?.id === 'synthetic-test.apps.googleusercontent.com' &&
      overview.client.source === 'own',
    vaultBinding:
      (await createVaultAccounts(join(userData, 'google-vault-accounts.json')).subFor(remote)) ===
      fixtureSub,
    speech: speech?.key === fixtureSpeechKey && speech.service === null,
  }
}
