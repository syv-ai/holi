import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkPiCli } from './pi-cli-contract.mjs'

const help = [
  '--session <path|id>',
  '--continue',
  '--resume',
  '--fork <path|id>',
  '--model <pattern>',
  '--provider <name>',
  '--mode <mode>',
  '--append-system-prompt <text>',
  '--no-tools',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--no-mcp',
  '--no-approve',
].join('\n')

function executable(contents) {
  const directory = mkdtempSync(join(tmpdir(), 'holi-pi-cli-test-'))
  const bin = join(directory, 'pi')
  writeFileSync(bin, `#!/usr/bin/env node\n${contents}`)
  chmodSync(bin, 0o755)
  return { directory, bin }
}

test('accepts exact-version help contract with a minimal test binary', () => {
  const fixture = executable(
    `process.stdout.write(process.argv[2] === '--version' ? '1.2.3\\n' : ${JSON.stringify(help + '\n')})`,
  )
  try {
    assert.equal(checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3' }).outcome, 'pass')
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects a version mismatch and removed CLI options', () => {
  const fixture = executable(
    `process.stdout.write(process.argv[2] === '--version' ? '1.2.3\\n' : '--mode <mode>\\n')`,
  )
  try {
    assert.match(
      checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.4' }).detail,
      /registry observation/,
    )
    assert.match(
      checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3' }).detail,
      /missing required options/,
    )
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})
