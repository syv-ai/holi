import test from 'node:test'
import assert from 'node:assert/strict'
import { checkProbe, exactVersion, isolatedEnvironment } from './claude-compatibility-checks.mjs'

test('Claude probe environment is allowlisted and isolated', () => {
  const env = isolatedEnvironment('/tmp/probe', '/bin')
  assert.deepEqual(Object.keys(env).sort(), [
    'CI',
    'CLAUDE_CONFIG_DIR',
    'HOME',
    'PATH',
    'npm_config_cache',
    'npm_config_globalconfig',
    'npm_config_userconfig',
  ])
  assert.equal(env.HOME, '/tmp/probe/home')
  assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/probe/home/.claude')
})

test('accepts exact Claude Code versions only', () => {
  assert.equal(exactVersion('2.1.319 (Claude Code)', '2.1.319'), true)
  assert.equal(exactVersion('claude-code 2.1.319', '2.1.319'), true)
  assert.equal(exactVersion('2.1.3190', '2.1.319'), false)
  assert.equal(exactVersion('garbage 2.1.319 trailing', '2.1.319'), false)
  assert.equal(exactVersion('2.1.319', '2.1.junk'), false)
  assert.equal(exactVersion('2.1.319\\nClaude Code', '2.1.319'), false)
})

test('names missing commands, options, timeouts and nonzero probes', () => {
  assert.match(
    checkProbe({ status: 0 }, ['agents', '--all'], 'Usage: claude agents'),
    /missing consumed/,
  )
  assert.equal(checkProbe({ status: null, error: { code: 'ETIMEDOUT' } }, [], ''), 'timed out')
  assert.equal(checkProbe({ status: 2 }, [], ''), 'exit 2')
  assert.equal(checkProbe({ status: 0 }, ['--all'], 'agents --json --all'), null)
})
