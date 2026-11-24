import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeFirstTargetConnections } from '../scripts/upgrade-first-target.mjs'

type Scenario = 'observed' | 'permission-denied' | 'foreign-listener' | 'process-changed'

// The native boundary is modeled here; signing, AX and real capture require the hosted fixture.
async function fixture(scenario: Scenario) {
  const root = await mkdtemp(join(tmpdir(), 'holi-565-native-'))
  const profile = join(root, 'Holi')
  const vaultPath = join(root, 'vault')
  const evidenceDirectory = join(root, 'images')
  for (const path of [profile, vaultPath, evidenceDirectory]) await mkdir(path, { mode: 0o700 })
  const token = 'a'.repeat(64)
  const email = 'holi-upgrade-fixture@example.invalid'
  const remote = 'fixture/upgrade'
  let requests = 0
  const server = createServer(async (request, response) => {
    requests++
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const form = new URLSearchParams(Buffer.concat(chunks).toString())
    const accepted =
      request.method === 'POST' &&
      request.url === '/cli' &&
      request.headers['x-holi-cli-token'] === token &&
      form.get('cwd') === vaultPath &&
      JSON.stringify(form.getAll('argv')) ===
        JSON.stringify(['google', 'accounts', '--json', '--vault', remote])
    response.writeHead(accepted ? 200 : 422, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ remote, state: 'connected', account: { email }, client: { source: 'own' } }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
  await writeFile(
    join(profile, 'cli-endpoint.json'),
    JSON.stringify({ host: '127.0.0.1', port: address.port, token }),
    { mode: 0o600 },
  )
  const startMicros = Date.now() * 1000
  const pid = process.pid
  const helper = join(root, 'observer')
  async function run(command: string, _args: string[], options: { input?: string }) {
    if (command === '/usr/sbin/lsof')
      return { output: `p${scenario === 'foreign-listener' ? pid + 1 : pid}\n` }
    if (command !== helper) throw new Error('unexpected fixture command')
    const request = JSON.parse(options.input ?? '{}')
    if (request.action === 'identify')
      return {
        output: JSON.stringify({
          outcome: 'identified',
          pid,
          startMicros: startMicros + (scenario === 'process-changed' && requests > 0 ? 1 : 0),
          signatureVerified: true,
          uid: process.getuid!(),
        }),
      }
    if (request.action !== 'observe') throw new Error('invalid fixture operation')
    if (scenario === 'permission-denied')
      return {
        output: JSON.stringify({
          outcome: 'precondition-unavailable',
          reason: 'screen-capture-permission',
          permissions: { screenCapture: false, accessibility: false, unrelated: token },
        }),
      }
    await writeFile(
      join(evidenceDirectory, 'first-target-google-connected.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7kAAAAASUVORK5CYII=',
        'base64',
      ),
      { mode: 0o600 },
    )
    return {
      output: JSON.stringify({
        outcome: 'observed',
        pid,
        startMicros,
        signatureVerified: true,
        windowId: 7,
        googleConnectionsPanelAsserted: true,
        permissions: { screenCapture: true, accessibility: true },
        screenshot: 'first-target-google-connected.png',
      }),
    }
  }
  return {
    token,
    evidenceDirectory,
    requests: () => requests,
    observe: () =>
      observeFirstTargetConnections({
        run,
        helper,
        fixtureRoot: root,
        bundlePath: join(root, 'Holi.app'),
        teamIdentifier: 'AAAAAAAAAA',
        pid,
        notBeforeMicros: startMicros - 1000,
        profile,
        vaultPath,
        remote,
        evidenceDirectory,
        email,
      }),
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(root, { recursive: true, force: true })
    },
  }
}

describe('first-target connection observation', () => {
  it('requires correlated backend and native UI evidence before accepting restoration', async () => {
    const app = await fixture('observed')
    try {
      const result = await app.observe()
      expect(result).toMatchObject({
        outcome: 'observed',
        backendBoundToTarget: true,
        googleConnectionsPanelAsserted: true,
      })
      expect(await readdir(app.evidenceDirectory)).toContain(result.screenshot)
      expect(JSON.stringify(result)).not.toContain(app.token)
    } finally {
      await app.close()
    }
  })

  it('keeps denied capture permissions incomplete and strips unrelated native metadata', async () => {
    const app = await fixture('permission-denied')
    try {
      const result = await app.observe()
      expect(result).toMatchObject({
        outcome: 'precondition-unavailable',
        backendBoundToTarget: true,
        googleConnectionsPanelAsserted: false,
        screenshot: null,
      })
      expect(await readdir(app.evidenceDirectory)).toEqual([])
      expect(JSON.stringify(result)).not.toContain(app.token)
    } finally {
      await app.close()
    }
  })

  it('never sends a credential to a listener not owned by the first target', async () => {
    const app = await fixture('foreign-listener')
    try {
      expect(await app.observe()).toMatchObject({
        outcome: 'ownership-refused',
        backendBoundToTarget: false,
      })
      expect(app.requests()).toBe(0)
    } finally {
      await app.close()
    }
  })

  it('rejects a response when the target start identity changed during the request', async () => {
    const app = await fixture('process-changed')
    try {
      expect(await app.observe()).toMatchObject({
        outcome: 'ownership-refused',
        backendBoundToTarget: false,
      })
      expect(await readdir(app.evidenceDirectory)).toEqual([])
    } finally {
      await app.close()
    }
  })
})
