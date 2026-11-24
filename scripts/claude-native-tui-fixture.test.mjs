import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolatedEnvironment, prepareClaudeNativeTuiFixture } from './claude-native-tui-fixture.mjs'

test('Claude native fixture rejects incomplete setup before creating a run', async () => {
  await assert.rejects(prepareClaudeNativeTuiFixture({ version: 'latest' }), /exact version/)
  await assert.rejects(prepareClaudeNativeTuiFixture({ install: '/missing', version: '1.2.3' }))
})

test('fixture environment exposes only isolated config and does not inherit credentials or proxies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-claude-env-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const env = isolatedEnvironment({ root, home: join(root, 'home'), config: join(root, 'config'), vault: join(root, 'vault') })
  assert.equal(env.HOME, join(root, 'home'))
  assert.equal(env.CLAUDE_CONFIG_DIR, join(root, 'config'))
  assert.equal('ANTHROPIC_API_KEY' in env, false)
  assert.equal('HTTPS_PROXY' in env, false)
})
