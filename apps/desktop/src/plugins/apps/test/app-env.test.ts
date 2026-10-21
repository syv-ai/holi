/**
 * An app's secrets: only the names its app.yaml declares, from the vault's
 * `.env` with `.env.local` winning, and never the files themselves.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { emptyVaultSnapshot } from '@holi/shared'
import { envCapabilities, ENV_NAMESPACES, parseDotenv } from '../main/env'
import { noCoreServices } from '../../../main/capabilities/services'
import { vaultCapabilities, VAULT_NAMESPACES } from '../../../main/capabilities/vault-caps'
import { createCapabilityRegistry, type Door } from '../../../main/capabilities/registry'

const registry = createCapabilityRegistry()
registry.register(ENV_NAMESPACES, envCapabilities())
registry.register(
  VAULT_NAMESPACES,
  vaultCapabilities({
    updateSkills: async () => ({ summary: '', conflicts: null }),
    pendingSkills: async () => [],
    open: () => {},
    screenshot: async () => new Uint8Array(),
  }),
)

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holi-app-env-'))
  await mkdir(join(root, 'Notes.app'), { recursive: true })
  await writeFile(join(root, 'Notes.app/app.yaml'), 'env: [API_KEY, MODEL]\n')
})

afterEach(() => rm(root, { recursive: true, force: true }))

function call(method: string, params: Record<string, unknown>, door: Door = 'app') {
  return registry
    .run(
      method,
      door,
      {
        remote: 'syv-ai/vault',
        root,
        bundle: door === 'app' ? 'Notes.app' : null,
        snapshot: async () => emptyVaultSnapshot(),
        core: noCoreServices(),
      },
      params,
    )
    .then((r) => r.value)
}

it('gives an app the secrets it declares, .env.local over .env, and refuses the rest', async () => {
  await writeFile(join(root, '.env'), 'API_KEY=shared\nMODEL="small"\nOTHER=x\n')
  await writeFile(join(root, '.env.local'), 'export API_KEY=mine # this Mac\n')

  expect(await call('env.get', { name: 'API_KEY' })).toBe('mine')
  expect(await call('env.get', { name: 'MODEL' })).toBe('small')
  await expect(call('env.get', { name: 'OTHER' })).rejects.toThrow("not in this app's env")
  // Refused for what it is, before anything asks whether it exists.
  await expect(call('docs.read', { path: '.env' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
})

it('answers null for a declared secret the vault has no value for', async () => {
  expect(await call('env.get', { name: 'API_KEY' })).toBeNull()
})

it('reads dotenv lines as dotenv writes them', () => {
  expect(parseDotenv('# c\n\nA=1\nB = \' two # not a comment \'\nC="x\\ny"\nbad line\n')).toEqual({
    A: '1',
    B: ' two # not a comment ',
    C: 'x\ny',
  })
})
