import test from 'node:test'
import assert from 'node:assert/strict'
import { checkProbe, exactVersion, isolatedEnvironment } from './codex-compatibility-checks.mjs'

test('drops inherited credentials and config variables', () => {
  const inherited = {
    ...process.env,
    GH_TOKEN: 'must-not-exist',
    OPENAI_API_KEY: 'must-not-exist',
    npm_config_userconfig: '/real/config',
  }
  const clean = isolatedEnvironment('/scratch', inherited.PATH)
  assert.equal('GH_TOKEN' in clean, false)
  assert.equal('OPENAI_API_KEY' in clean, false)
  assert.equal(clean.HOME, '/scratch/home')
  assert.equal(clean.CODEX_HOME, '/scratch/home/.codex')
  assert.equal(clean.npm_config_userconfig, '/scratch/npmrc')
  assert.deepEqual(Object.keys(clean).sort(), [
    'CI',
    'CODEX_HOME',
    'HOME',
    'PATH',
    'npm_config_cache',
    'npm_config_globalconfig',
    'npm_config_userconfig',
  ])
  assert.notEqual(clean.npm_config_userconfig, inherited.npm_config_userconfig)
})

test('matches only the exact CLI version', () => {
  assert.equal(exactVersion('codex-cli 0.169.0', '0.169.0'), true)
  assert.equal(exactVersion('codex-cli 10.169.0', '0.169.0'), false)
})

test('rejects removed options, timeouts and nonzero help probes', () => {
  const flags = ['--json', '-C', '--sandbox']
  assert.match(checkProbe({ status: 0 }, flags, 'Usage: codex exec'), /missing consumed options/)
  assert.equal(checkProbe({ status: null, error: { code: 'ETIMEDOUT' } }, flags, ''), 'timed out')
  assert.equal(checkProbe({ status: 2 }, flags, ''), 'exit 2')
  assert.equal(checkProbe({ status: 0 }, flags, ' --json -C --sandbox'), null)
})
