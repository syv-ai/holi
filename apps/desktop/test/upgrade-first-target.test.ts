import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeFirstTargetConnections } from '../scripts/upgrade-first-target.mjs'

type Scenario =
  | 'observed'
  | 'permission-denied'
  | 'foreign-listener'
  | 'process-changed'
  | 'startup'
  | 'stale-endpoint'
  | 'malformed-native'
  | 'navigation-unavailable'
  | 'unsafe-navigation'
  | 'navigation-replaced'

// Native signing, AX and real capture remain the hosted fixture's responsibility.
async function fixture(scenario: Scenario) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holi-565-native-')))
  const profile = join(root, 'Holi')
  const vaultPath = join(root, 'vault')
  const evidenceDirectory = join(root, 'images')
  for (const path of [profile, vaultPath, evidenceDirectory]) await mkdir(path, { mode: 0o700 })
  const token = 'a'.repeat(64)
  const email = 'holi-upgrade-fixture@example.invalid'
  const remote = 'fixture/upgrade'
  let requests = 0
  let observationReturned = false
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
    if (accepted && scenario === 'startup' && requests === 1) {
      response.writeHead(422)
      response.end(
        'holi google.accounts: vault is closed; open it in Holi before running this command',
      )
      return
    }
    response.writeHead(accepted ? 200 : 422, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({ remote, state: 'connected', account: { email }, client: { source: 'own' } }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
  const descriptor = { host: '127.0.0.1', port: address.port, token }
  const stalePort = address.port === 65535 ? address.port - 1 : address.port + 1
  await writeFile(
    join(profile, 'cli-endpoint.json'),
    JSON.stringify(
      scenario === 'stale-endpoint'
        ? { ...descriptor, port: stalePort, token: 'b'.repeat(64) }
        : descriptor,
    ),
    { mode: 0o600 },
  )
  const startMicros = Date.now() * 1000
  const pid = process.pid
  const helper = join(root, 'observer')
  async function run(command: string, args: string[], options: { input?: string }) {
    if (command === '/usr/sbin/lsof') {
      if (scenario === 'stale-endpoint' && args.includes(`-iTCP@127.0.0.1:${stalePort}`)) {
        await writeFile(join(profile, 'cli-endpoint.json'), JSON.stringify(descriptor), {
          mode: 0o600,
        })
        throw Object.assign(new Error('no listener'), { exitCode: 1 })
      }
      if (!args.includes(`-iTCP@127.0.0.1:${address.port}`)) throw new Error('wrong listener query')
      return { output: `p${scenario === 'foreign-listener' ? pid + 1 : pid}\n` }
    }
    if (command !== helper) throw new Error('unexpected fixture command')
    const request = JSON.parse(options.input ?? '{}')
    const valid =
      request.fixtureRoot === root &&
      request.bundlePath === join(root, 'Holi.app') &&
      request.teamIdentifier === 'AAAAAAAAAA' &&
      request.pid === pid &&
      request.notBeforeMicros === startMicros - 1000 &&
      request.email === email &&
      request.evidenceDirectory === evidenceDirectory &&
      request.expectedStartMicros === startMicros
    if (!valid)
      return {
        output: JSON.stringify({ outcome: 'ownership-refused', reason: 'process-identity' }),
      }
    if (request.action === 'identify') {
      if (
        (scenario === 'process-changed' && requests > 0) ||
        (scenario === 'navigation-replaced' && observationReturned)
      )
        return {
          output: JSON.stringify({ outcome: 'ownership-refused', reason: 'process-changed' }),
        }
      return {
        output: JSON.stringify({
          outcome: 'identified',
          pid,
          startMicros,
          signatureVerified: true,
          uid: process.getuid!(),
        }),
      }
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
    if (['navigation-unavailable', 'unsafe-navigation', 'navigation-replaced'].includes(scenario)) {
      observationReturned = true
      const navigationStats: Record<string, unknown> = {
        activationSucceeded: true,
        expectedTriggerByRole: false,
        expectedTriggerByLabel: false,
        triggerTitleSeen: false,
        triggerDescriptionSeen: false,
        triggerValueSeen: false,
        settingsMenuSeen: false,
        connectionsControlSeen: true,
        connectionsHeadingSeen: false,
        googleSeen: false,
        emailSeen: false,
        emailWithinLabelSeen: false,
        disconnectSeen: false,
        disconnectDescriptionSeen: false,
        accountPressSucceeded: false,
        settingsPressSucceeded: false,
        connectionsPressSucceeded: false,
        deadlineReached: true,
        childrenReadAttempted: true,
        snapshotDeadlineReached: false,
        snapshotNodeLimitReached: false,
        snapshotDepthLimitReached: false,
        snapshotReadFailed: false,
        navigationScanStarted: true,
        windowsSeen: 1,
        visited: 42,
        windowsStatus: 0,
        childrenStatus: 0,
      }
      if (scenario === 'unsafe-navigation') navigationStats.rawLabel = token
      return {
        output: JSON.stringify({
          outcome: 'observation-unavailable',
          reason: 'connections-panel-not-asserted',
          pid,
          startMicros,
          signatureVerified: true,
          googleConnectionsPanelAsserted: false,
          permissions: { screenCapture: true, accessibility: true },
          navigationStats,
          unrelated: token,
        }),
      }
    }
    if (scenario === 'malformed-native')
      return {
        output: JSON.stringify({
          outcome: 'observed',
          pid,
          startMicros,
          signatureVerified: true,
          windowId: null,
          googleConnectionsPanelAsserted: true,
          screenshot: '../outside.png',
        }),
      }
    await writeFile(
      join(evidenceDirectory, 'first-target-google-connected.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
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
        expectedStartMicros: startMicros,
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

describe.skipIf(process.platform === 'win32')('first-target connection observation', () => {
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

  it.each(['startup', 'stale-endpoint'] as const)(
    'waits for %s readiness without accepting another actor',
    async (scenario) => {
      const app = await fixture(scenario)
      try {
        expect(await app.observe()).toMatchObject({
          outcome: 'observed',
          backendBoundToTarget: true,
        })
        expect(app.requests()).toBe(scenario === 'startup' ? 2 : 1)
      } finally {
        await app.close()
      }
    },
  )

  it.each(['navigation-unavailable', 'unsafe-navigation', 'navigation-replaced'] as const)(
    'keeps %s incomplete and exposes only bound structured diagnostics',
    async (scenario) => {
      const app = await fixture(scenario)
      try {
        const result = await app.observe()
        expect(result).toMatchObject({
          outcome:
            scenario === 'navigation-replaced' ? 'ownership-refused' : 'observation-unavailable',
          googleConnectionsPanelAsserted: false,
          screenshot: null,
        })
        if (scenario === 'navigation-unavailable') {
          expect(result).toMatchObject({
            navigationStats: {
              connectionsControlSeen: true,
              deadlineReached: true,
              snapshotDeadlineReached: false,
              snapshotNodeLimitReached: false,
              snapshotDepthLimitReached: false,
              navigationScanStarted: true,
            },
          })
        } else expect(result).not.toHaveProperty('navigationStats')
        expect(JSON.stringify(result)).not.toContain(app.token)
        expect(await readdir(app.evidenceDirectory)).toEqual([])
      } finally {
        await app.close()
      }
    },
  )

  it('rejects malformed native success without creating or accepting an image', async () => {
    const app = await fixture('malformed-native')
    try {
      expect(await app.observe()).toMatchObject({ outcome: 'ownership-refused', screenshot: null })
      expect(await readdir(app.evidenceDirectory)).toEqual([])
    } finally {
      await app.close()
    }
  })
})
