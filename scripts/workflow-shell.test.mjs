import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const workflow = readFileSync(
  new URL('../.github/workflows/harness-monitor.yml', import.meta.url),
  'utf8',
)

test('every workflow run block has valid bash syntax', () => {
  const blocks = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)]
  assert.ok(blocks.length > 0, 'expected multiline run blocks')
  for (const [index, match] of blocks.entries()) {
    const script = match[1]
      .split('\n')
      .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
      .join('\n')
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' })
    assert.equal(result.status, 0, `workflow run block ${index + 1}: ${result.stderr}`)
  }
})
