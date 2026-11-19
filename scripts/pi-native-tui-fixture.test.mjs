import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createLocalModelServer,
  isolatedEnvironment,
  runPiNativeTuiFixture,
  verifyPiProvenance,
} from './pi-native-tui-fixture.mjs'

async function packageFixture() {
  const root = await mkdtemp(join(tmpdir(), 'holi-660-package-test-'))
  const folder = join(root, 'node_modules/@earendil-works/pi-coding-agent')
  await mkdir(join(folder, 'dist/bundle'), { recursive: true })
  await writeFile(
    join(folder, 'package.json'),
    JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.5.2' }),
  )
  const bin = join(folder, 'dist/bundle/cli.js')
  await writeFile(bin, 'throw new Error("Provenance inspection must not execute this file")')
  const linked = process.platform === 'win32' ? bin : join(root, 'pi')
  if (linked !== bin) await symlink(bin, linked)
  return { root, bin, linked }
}

async function waitFor(predicate) {
  const until = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < until, 'fixture condition timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test(
  'provenance resolves executable symlinks without executing producer code',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await packageFixture()
    try {
      const result = await verifyPiProvenance({ bin: fixture.linked, expectedVersion: '1.5.2' })
      assert.equal(result.executable, await realpath(fixture.bin))
      assert.match(result.packageDigest, /^[a-f0-9]{64}$/)
      assert.equal(result.sourceCommitAvailable, false)
      await assert.rejects(
        verifyPiProvenance({ bin: fixture.bin, expectedVersion: '9.9.9' }),
        (error) => error.outcome === 'mismatch',
      )
      await assert.rejects(
        verifyPiProvenance({ bin: '/missing/pi', expectedVersion: '1.5.2' }),
        /unavailable/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  },
)

test('unreviewed package bytes cannot execute as native upstream evidence', async () => {
  const fixture = await packageFixture()
  try {
    const result = await runPiNativeTuiFixture({
      bin: fixture.bin,
      expectedVersion: '1.5.2',
      artifactDirectory: join(fixture.root, 'artifacts'),
    })
    assert.equal(result.outcome, process.platform === 'darwin' ? 'mismatch' : 'unverified')
    assert.equal(result.cleanup.runtimeRemoved, true)
    assert.deepEqual(result.cleanup.processes, [])
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('unsupported platform fails before provenance or producer execution and leaves no runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-660-platform-test-'))
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const result = await runPiNativeTuiFixture({
      bin: '/must/not/execute',
      expectedVersion: '1.5.2',
      artifactDirectory: root,
    })
    assert.equal(result.outcome, 'unverified')
    assert.match(result.detail, /Seatbelt/)
    assert.deepEqual(result.cleanup.processes, [])
    assert.equal(result.cleanup.runtimeRemoved, true)
    assert.equal(JSON.parse(await readFile(join(root, 'receipt.json'))).outcome, 'unverified')
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact paths cannot enter the checkout through an external symlink ancestor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-660-artifact-path-test-'))
  try {
    await symlink(process.cwd(), join(root, 'checkout'), 'junction')
    await assert.rejects(
      runPiNativeTuiFixture({
        bin: '/unused',
        expectedVersion: '1.5.2',
        artifactDirectory: join(root, 'checkout', 'must-not-create-artifacts'),
      }),
      /outside the repository/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native environment does not inherit credentials, proxies, loaders or personal Pi settings', () => {
  const env = isolatedEnvironment({
    root: '/fixture',
    home: '/fixture/home',
    profile: '/fixture/pi',
  })
  assert.equal(env.PI_OFFLINE, '1')
  assert.equal(env.PI_CODING_AGENT_DIR, '/fixture/pi')
  assert.equal(env.HOME, '/fixture/home')
  for (const key of [
    'NODE_OPTIONS',
    'ANTHROPIC_API_KEY',
    'HTTPS_PROXY',
    'PI_AGENT_DIR',
    'OPENAI_BASE_URL',
  ])
    assert.equal(key in env, false)
  assert.equal(env.OPENAI_API_KEY, 'local-only-fixture-key')
})

test('containment probe cannot consume held model stream; cancellation observes socket closure', async () => {
  const fixture = createLocalModelServer()
  await new Promise((resolve) => fixture.server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${fixture.server.address().port}`
  const request = { model: 'fixture-model', messages: [{ role: 'user', content: 'synthetic' }] }
  const controller = new AbortController()
  try {
    assert.equal((await fetch(`${url}/probe`)).status, 404)
    assert.equal(
      (await fetch(`${url}/v1/chat/completions`, { method: 'POST', body: '{' })).status,
      400,
    )
    const response = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    const reader = response.body.getReader()
    assert.match(Buffer.from((await reader.read()).value).toString(), /Held-open/)
    assert.equal(fixture.streams[0].closed, false)
    assert.equal(fixture.streams[0].completed, false)
    controller.abort()
    await waitFor(() => fixture.streams[0].closed)
    assert.equal(fixture.streams[0].completed, false)
    const recovery = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
    assert.match(await recovery.text(), /allow this tool/)
    assert.equal(fixture.requests.length, 2)
    assert.equal(fixture.streams[1].completed, true)
    const oversized = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      body: 'x'.repeat(65537),
    })
    assert.equal(oversized.status, 413)
  } finally {
    controller.abort()
    await new Promise((resolve) => {
      fixture.server.close(resolve)
      fixture.server.closeAllConnections()
    })
  }
})
