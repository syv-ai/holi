import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { isolatedEnvironment, runClaudeNativeTuiFixture } from './claude-native-tui-fixture.mjs'

test('Claude native fixture rejects unsupported versions and timeouts before launch', async () => {
  await assert.rejects(runClaudeNativeTuiFixture({ version: 'latest' }), /2.1.319/)
  await assert.rejects(
    runClaudeNativeTuiFixture({
      install: '/missing',
      version: '2.1.319',
      artifactDirectory: '/tmp/out',
      timeout: 15001,
    }),
    /timeout/,
  )
})

test('failed package setup retains an incomplete receipt without launching a producer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-claude-setup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifactDirectory = join(root, 'artifacts')
  const result = await runClaudeNativeTuiFixture({
    install: join(root, 'missing'),
    version: '2.1.319',
    artifactDirectory,
  })
  assert.equal(result.outcome, 'unverified')
  assert.equal(result.nativeLaunched, false)
  assert.equal(result.cleanup.runtimeRemoved, true)
  assert.equal(result.cleanup.serverClosed, true)
  assert.deepEqual(result.ownership.targets, [])
  const persisted = JSON.parse(await readFile(join(artifactDirectory, 'receipt.json'), 'utf8'))
  assert.equal(persisted.nativeLaunched, false)
  assert.equal(persisted.outcome, 'unverified')
})

for (const scenario of ['incomplete selector', 'request before selector', 'deadline']) {
  test(
    `constructed producer cannot authorize input after ${scenario}`,
    { skip: process.platform !== 'darwin', timeout: 20000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'holi-claude-controller-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const install = join(root, 'install')
      const packages = join(install, 'node_modules', '@anthropic-ai')
      const wrapper = join(packages, 'claude-code')
      const native = join(packages, `claude-code-darwin-${process.arch}`)
      await mkdir(wrapper, { recursive: true })
      await mkdir(native)
      await writeFile(
        join(wrapper, 'package.json'),
        JSON.stringify({
          name: '@anthropic-ai/claude-code',
          version: '2.1.319',
          bin: { claude: 'bin/claude.exe' },
        }),
      )
      await writeFile(
        join(native, 'package.json'),
        JSON.stringify({
          name: `@anthropic-ai/claude-code-darwin-${process.arch}`,
          version: '2.1.319',
          os: ['darwin'],
          cpu: [process.arch],
        }),
      )
      // Constructed controller double, never retained as native Claude evidence.
      const body =
        scenario === 'deadline'
          ? 'while :; do sleep 1; done'
          : scenario === 'request before selector'
            ? '/usr/bin/curl -s "$ANTHROPIC_BASE_URL/probe" >/dev/null\nprintf "Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust? ❯No,exit Yes,Itrustthisfolder\\n"\nsleep 5'
            : 'printf "No, exit\\n"'
      const binary = join(native, 'claude')
      await writeFile(
        binary,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.1.319 (Claude Code)\\n"; exit 0; fi\n' +
          body +
          '\n',
      )
      await chmod(binary, 0o700)
      const result = await runClaudeNativeTuiFixture({
        install: relative(process.cwd(), install),
        version: '2.1.319',
        artifactDirectory: join(root, 'artifacts'),
        timeout: scenario === 'deadline' ? 2500 : 10000,
      })
      assert.equal(result.outcome, 'unverified')
      assert.equal(result.nativeLaunched, true)
      assert.deepEqual(result.inputs, [])
      assert.equal(result.cleanup.runtimeRemoved, true)
      assert.equal(result.cleanup.serverClosed, true)
      assert.ok(result.cleanup.processes.length > 0)
      assert.ok(result.cleanup.processes.every((p) => p.drained))
      if (scenario === 'request before selector') assert.ok(result.nativeRequests > 0)
    },
  )
}

test('fixture environment exposes only isolated config and does not inherit credentials or proxies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-claude-env-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = isolatedEnvironment({ root, home: join(root, 'home'), config: join(root, 'config') })
  assert.equal(env.HOME, join(root, 'home'))
  assert.equal(env.CLAUDE_CONFIG_DIR, join(root, 'config'))
  assert.equal(env.PATH, '/usr/bin:/bin')
  assert.equal('ANTHROPIC_API_KEY' in env, false)
  assert.equal('HTTPS_PROXY' in env, false)
})
