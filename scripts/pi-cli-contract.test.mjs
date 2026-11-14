import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkPiCli } from './pi-cli-contract.mjs'

const help = [
  '--session <path|id>',
  '--session-id <id>',
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

function validFixture() {
  return executable(
    `if (process.argv[2] === '--version') process.stdout.write('1.2.3\\n'); else process.stdout.write(${JSON.stringify(help + '\n')})`,
  )
}

test('accepts exact-version help contract with a minimal test binary', () => {
  const fixture = validFixture()
  try {
    assert.equal(checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3' }).outcome, 'pass')
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('requires the production session-id option specifically', () => {
  const fixture = executable(
    `process.stdout.write(process.argv[2] === '--version' ? '1.2.3\\n' : ${JSON.stringify(help.replace('--session-id <id>\n', '') + '\n')})`,
  )
  try {
    assert.match(
      checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3' }).detail,
      /--session-id <id>/,
    )
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects a version substring rather than an exact version', () => {
  const fixture = executable(
    `process.stdout.write(process.argv[2] === '--version' ? 'v1.2.3 extra\\n' : ${JSON.stringify(help + '\n')})`,
  )
  try {
    assert.match(
      checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3' }).detail,
      /returned v1\.2\.3 extra/,
    )
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('reports nonzero exit with bounded diagnostics', () => {
  const fixture = executable(`process.stderr.write('x'.repeat(5000)); process.exit(7)`)
  try {
    const result = checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3' })
    assert.equal(result.outcome, 'mismatch')
    assert.ok(result.detail.length <= 1100)
    assert.match(result.detail, /exited 7/)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('times out without unbounded diagnostics', () => {
  const fixture = executable(`setTimeout(() => process.stdout.write('late'), 1000)`)
  try {
    const result = checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3', timeout: 20 })
    assert.equal(result.outcome, 'mismatch')
    assert.ok(result.detail.length <= 1100)
    assert.match(result.detail, /timed out/)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('bounds excessive output and mismatch version evidence', () => {
  const fixture = executable(`process.stdout.write('x'.repeat(300000))`)
  try {
    const outputResult = checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3' })
    assert.equal(outputResult.outcome, 'mismatch')
    assert.ok(outputResult.detail.length <= 1100)
    const versionFixture = executable(`process.stdout.write('x'.repeat(5000))`)
    try {
      const mismatch = checkPiCli({ bin: versionFixture.bin, expectedVersion: '1.2.3' })
      assert.ok(mismatch.detail.length <= 1100)
    } finally {
      rmSync(versionFixture.directory, { recursive: true, force: true })
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('uses disposable home and cwd and excludes inherited secrets and config', () => {
  const evidence = join(tmpdir(), `holi-pi-cli-evidence-${process.pid}.json`)
  const fixture = executable(
    `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({home:process.env.HOME,cwd:process.cwd(),env:process.env})); process.stdout.write(process.argv[2] === '--version' ? '1.2.3\\n' : ${JSON.stringify(help + '\n')})`,
  )
  const original = Object.fromEntries(
    ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PI_CODING_AGENT_DIR', 'NODE_OPTIONS'].map((key) => [
      key,
      process.env[key],
    ]),
  )
  try {
    process.env.ANTHROPIC_API_KEY = 'synthetic-secret'
    process.env.OPENAI_API_KEY = 'synthetic-secret'
    process.env.PI_CODING_AGENT_DIR = '/synthetic/user/config'
    process.env.NODE_OPTIONS = '--require=/synthetic/preload'
    assert.equal(checkPiCli({ bin: fixture.bin, expectedVersion: '1.2.3' }).outcome, 'pass')
    const { home, cwd, env } = JSON.parse(readFileSync(evidence, 'utf8'))
    assert.notEqual(home, process.env.HOME)
    assert.notEqual(cwd, process.cwd())
    for (const key of Object.keys(original)) assert.equal(env[key], undefined)
  } finally {
    for (const [key, value] of Object.entries(original))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    rmSync(evidence, { force: true })
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('raw command stdout remains parseable JSON', async () => {
  const fixture = validFixture()
  try {
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync(
      process.execPath,
      ['./scripts/pi-cli-contract.mjs', fixture.bin, '1.2.3'],
      {
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.equal(JSON.parse(result.stdout).outcome, 'pass')
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})
