import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProducerProof, validateNativeProof } from './codex-exec-producer.mjs'

async function installFixture(root) {
  const npm = join(root, 'npm-fixture.mjs')
  await writeFile(
    npm,
    `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const prefix = process.argv[process.argv.indexOf('--prefix') + 1]
const dir = join(prefix, 'node_modules', '@openai', 'codex', 'bin')
await mkdir(dir, { recursive: true })
await writeFile(join(dir, '..', 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.0' }))
await writeFile(join(dir, 'codex.js'), 'console.log("codex-cli 0.169.0")\\n')
`,
    { mode: 0o755 },
  )
  return npm
}

async function pnpmFixture(root, source) {
  const pnpm = join(root, 'pnpm-fixture.mjs')
  await writeFile(pnpm, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 })
  return pnpm
}

test('native producer runner reports install failure as unavailable setup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-install-'))
  try {
    const npm = join(root, 'npm')
    await writeFile(npm, '#!/bin/sh\nexit 17\n', { mode: 0o755 })
    const result = await runProducerProof({ npm, pnpm: 'unused' })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'setup-unavailable')
    assert.equal(result.evidence.version, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native producer runner distinguishes wrong installed CLI version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-version-'))
  try {
    const npm = join(root, 'npm-fixture.mjs')
    await writeFile(
      npm,
      `#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const prefix = process.argv[process.argv.indexOf('--prefix') + 1]
const dir = join(prefix, 'node_modules', '@openai', 'codex', 'bin')
await mkdir(dir, { recursive: true })
await writeFile(join(dir, '..', 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.0' }))
await writeFile(join(dir, 'codex.js'), 'console.log("codex-cli 9.9.9")\\n')
`,
      { mode: 0o755 },
    )
    const result = await runProducerProof({ npm, pnpm: 'unused' })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'observed-contract-error')
    assert.equal(result.evidence.version, 'codex-cli 9.9.9')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('nonzero version probe is setup unavailable, not a version mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-version-launch-'))
  try {
    const npm = join(root, 'npm-fixture.mjs')
    await writeFile(
      npm,
      `#!/usr/bin/env node\nimport { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path'; const dir = join(process.argv[process.argv.indexOf('--prefix') + 1], 'node_modules', '@openai', 'codex'); await mkdir(join(dir, 'bin'), { recursive: true }); await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.0' })); await writeFile(join(dir, 'bin', 'codex.js'), 'process.exit(1)\\n')`,
      { mode: 0o755 },
    )
    const result = await runProducerProof({ npm, pnpm: 'unused' })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'setup-unavailable')
    assert.equal(result.evidence.version, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zero-exit fake Vitest without a native artifact is never proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-empty-'))
  try {
    const npm = await installFixture(root)
    const pnpm = await pnpmFixture(
      root,
      'process.stdout.write("Test Files 1 passed\\nTests 0 passed (0)\\n")',
    )
    const result = await runProducerProof({ npm, pnpm })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'incomplete-proof')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zero-test and skipped-test runner output cannot pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-skipped-'))
  try {
    const npm = await installFixture(root)
    const pnpm = await pnpmFixture(
      root,
      'process.stdout.write(process.env.HOLI_CODEX_PROOF_OUTPUT ? "Test Files 1 passed\\nTests 5 skipped (5)\\n" : "")',
    )
    const result = await runProducerProof({ npm, pnpm })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'incomplete-proof')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('all native contract failures are classified from explicit scenario evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-contract-'))
  try {
    const npm = await installFixture(root)
    const scenarios = ['initial-turn', 'follow-up', 'http-400', 'stall-stop', 'stall-leave'].map(
      (name) => ({
        name,
        stage: 'native-contract',
        status: 'mismatch',
        failureKind: 'contract',
        failure: 'fixture contract failed',
        rawProcesses: [
          {
            pid: 123,
            bin: '/unused',
            args: ['exec', '--json'],
            stdout: '',
            stderr: '',
            exitCode: 1,
            signal: null,
          },
        ],
      }),
    )
    const artifact = {
      schema: 'holi.codex-exec-producer.v1',
      package: '@openai/codex',
      expectedVersion: '0.169.0',
      version: 'codex-cli 0.169.0',
      bin: join(root, 'unused'),
      scenarios,
    }
    const pnpm = await pnpmFixture(
      root,
      `import { writeFile } from 'node:fs/promises'; const proof = ${JSON.stringify(artifact)}; proof.bin = process.env.HOLI_CODEX_BIN; for (const scenario of proof.scenarios) scenario.rawProcesses[0].bin = proof.bin; await writeFile(process.env.HOLI_CODEX_PROOF_OUTPUT, JSON.stringify(proof)); process.stdout.write('5 failed')`,
    )
    const result = await runProducerProof({ npm, pnpm })
    assert.equal(result.evidence.classification, 'observed-contract-error')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a setup failure after an earlier native pass remains setup-unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-late-setup-'))
  try {
    const npm = await installFixture(root)
    const scenarios = [
      {
        name: 'initial-turn',
        stage: 'host-lifecycle',
        status: 'pass',
        rawProcesses: [{ pid: 123 }],
      },
      ...['follow-up', 'http-400', 'stall-stop', 'stall-leave'].map((name) => ({
        name,
        stage: 'setup',
        status: 'unverified',
        failureKind: 'setup',
        failure: 'bind failed',
      })),
    ]
    const artifact = {
      schema: 'holi.codex-exec-producer.v1',
      package: '@openai/codex',
      expectedVersion: '0.169.0',
      version: 'codex-cli 0.169.0',
      scenarios,
    }
    const pnpm = await pnpmFixture(
      root,
      `import { writeFile } from 'node:fs/promises'; const proof = ${JSON.stringify(artifact)}; proof.bin = process.env.HOLI_CODEX_BIN; await writeFile(process.env.HOLI_CODEX_PROOF_OUTPUT, JSON.stringify(proof)); process.stdout.write('1 passed 4 failed')`,
    )
    const result = await runProducerProof({ npm, pnpm })
    assert.equal(result.evidence.classification, 'setup-unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('malformed, partial, oversized and unknown native proof are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-artifact-'))
  try {
    const npm = await installFixture(root)
    for (const payload of [
      'not-json',
      JSON.stringify({ schema: 'wrong' }),
      'x'.repeat(1024 * 1024 + 1),
    ]) {
      const pnpm = await pnpmFixture(
        root,
        `import { writeFile } from 'node:fs/promises'; await writeFile(process.env.HOLI_CODEX_PROOF_OUTPUT, ${JSON.stringify(payload)}); process.stdout.write("5 passed")`,
      )
      const result = await runProducerProof({ npm, pnpm })
      assert.equal(result.failed, true)
      assert.equal(result.evidence.classification, 'incomplete-proof')
    }
    assert.match(validateNativeProof(null, '/pinned/codex'), /identity/)
    assert.match(
      validateNativeProof(
        {
          schema: 'holi.codex-exec-producer.v1',
          package: '@openai/codex',
          expectedVersion: '0.169.0',
          version: 'codex-cli 0.169.0',
          bin: '/pinned/codex',
          scenarios: [],
        },
        '/pinned/codex',
      ),
      /incomplete/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detached native groups drain after early exit and timeout without killing unrelated roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-detached-'))
  const pidFile = join(root, 'owned-pids')
  try {
    const npm = await installFixture(root)
    const grandchildSource = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    const childSource = `process.on('SIGTERM', () => {}); const g = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile + '.grand')}, String(g.pid)); setInterval(() => {}, 1000)`
    const run = async (mode, timeout) => {
      const runner = await pnpmFixture(
        root,
        `import { spawn } from 'node:child_process'; import { writeFile } from 'node:fs/promises'; const marker = ${JSON.stringify(pidFile)}; const bin = process.env.HOLI_CODEX_BIN; const p = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, bin], { detached: true, stdio: 'ignore' }); await new Promise(r => setTimeout(r, 250)); await writeFile(marker, String(p.pid)); ${mode === 'exit' ? 'process.exit(0)' : 'setInterval(() => {}, 1000)'}`,
      )
      return runProducerProof({ npm, pnpm: runner, timeout })
    }
    for (const [mode, timeout] of [
      ['exit', 8_000],
      ['hang', 3_000],
    ]) {
      const result = await run(mode, timeout)
      assert.equal(result.failed, true)
      assert.equal(result.evidence.cleanup.processesDrained, true)
      assert.equal(result.evidence.cleanup.rootRemoved, true)
      if (mode === 'exit') assert.equal(result.evidence.test.code, 0, result.evidence.test.stderr)
      else assert.equal(result.evidence.test.timedOut, true)
      const pid = Number(await (await import('node:fs/promises')).readFile(pidFile, 'utf8'))
      const grandchild = Number(
        await (await import('node:fs/promises')).readFile(pidFile + '.grand', 'utf8'),
      )
      for (const childPid of [pid, grandchild]) {
        assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' })
      }
      await (await import('node:fs/promises')).rm(pidFile, { force: true })
      await (await import('node:fs/promises')).rm(pidFile + '.grand', { force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('false ledger ownership cannot signal a process from another root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-false-ledger-'))
  const pidFile = join(root, 'unrelated-pid')
  try {
    const npm = await installFixture(root)
    const pnpm = await pnpmFixture(
      root,
      `import { spawn } from 'node:child_process'; import { appendFile, writeFile } from 'node:fs/promises'; const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); await writeFile(${JSON.stringify(pidFile)}, String(child.pid)); await appendFile(process.env.HOLI_CODEX_PROCESS_LEDGER, JSON.stringify({ pid: child.pid, group: -child.pid, bin: process.env.HOLI_CODEX_BIN, cwd: process.cwd(), ownedRoot: ${JSON.stringify(root + '-sibling')} }) + '\\n'); process.exit(0)`,
    )
    const result = await runProducerProof({ npm, pnpm })
    assert.equal(result.evidence.cleanup.processesDrained, true)
    const pid = Number(await (await import('node:fs/promises')).readFile(pidFile, 'utf8'))
    assert.doesNotThrow(() => process.kill(pid, 0))
    process.kill(-pid, 'SIGKILL')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('forged valid-looking SDK ledger cannot kill an unrelated detached live group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-forged-ledger-'))
  const pidFile = join(root, 'unrelated-pid')
  try {
    const npm = await installFixture(root)
    const pnpm = await pnpmFixture(
      root,
      `import { spawn } from 'node:child_process'; import { appendFile, writeFile } from 'node:fs/promises'; const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); await writeFile(${JSON.stringify(pidFile)}, String(child.pid)); await appendFile(process.env.HOLI_CODEX_PROCESS_LEDGER, JSON.stringify({ pid: child.pid, group: -child.pid, bin: process.env.HOLI_CODEX_BIN, cwd: process.cwd(), ownedRoot: ${JSON.stringify(root)} }) + '\\\\n'); process.exit(0)`,
    )
    const result = await runProducerProof({ npm, pnpm })
    assert.equal(result.evidence.cleanup.processesDrained, true)
    const pid = Number(await (await import('node:fs/promises')).readFile(pidFile, 'utf8'))
    assert.doesNotThrow(() => process.kill(pid, 0))
    process.kill(-pid, 'SIGKILL')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('output cap and deadline are incomplete, and early runner exit drains its child group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-bounds-'))
  try {
    const npm = await installFixture(root)
    const noisy = await pnpmFixture(root, 'process.stdout.write("x".repeat(2 * 1024 * 1024 + 10))')
    const capped = await runProducerProof({ npm, pnpm: noisy, timeout: 8_000 })
    assert.equal(capped.failed, true)
    assert.equal(capped.evidence.classification, 'incomplete-proof')

    const child = await pnpmFixture(
      root,
      `import { spawn } from 'node:child_process'; const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(p.pid)); process.exit(0)`,
    )
    const exited = await runProducerProof({ npm, pnpm: child, timeout: 8_000 })
    assert.equal(exited.failed, true)
    assert.equal(exited.evidence.test.groupDrained, true)
    assert.equal(exited.evidence.cleanup.rootRemoved, true)
    assert.equal(exited.evidence.cleanup.processesDrained, true)

    const resistant = await pnpmFixture(
      root,
      `import { spawn } from 'node:child_process'; const p = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(p.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`,
    )
    const expired = await runProducerProof({ npm, pnpm: resistant, timeout: 3_000 })
    assert.equal(expired.failed, true)
    assert.equal(expired.evidence.classification, 'incomplete-proof')
    assert.equal(expired.evidence.test.timedOut, true)
    assert.equal(expired.evidence.test.groupDrained, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
