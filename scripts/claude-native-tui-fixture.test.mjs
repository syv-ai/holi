import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedEnvironment, runClaudeNativeTuiFixture } from './claude-native-tui-fixture.mjs'

test('Claude native fixture rejects unsupported versions and timeouts before launch', async () => {
  await assert.rejects(runClaudeNativeTuiFixture({ version: 'latest' }), /2.1.319/)
  await assert.rejects(runClaudeNativeTuiFixture({ install: '/missing', version: '2.1.319', artifactDirectory: '/tmp/out', timeout: 15001 }), /timeout/)
})

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
