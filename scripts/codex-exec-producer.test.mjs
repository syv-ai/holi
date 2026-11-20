import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProducerProof, validateNativeProof } from './codex-exec-producer.mjs'
import { leaseBuildScript } from './producer-command.mjs'

// These commands are all fixture programs with no children of their own. Keep
// their handles so an expected retained root can be removed under test authority.
async function runFakeProof(t, params) {
  const processes = []
  const calls = []
  const { buildCode = 0, ...proofOptions } = params
  const adapter = {
    spawnChild(command, args, options) {
      calls.push(args)
      const child = spawn(
        command,
        args[0] === leaseBuildScript ? ['-e', `process.exit(${buildCode})`] : args,
        options,
      )
      processes.push({ child, closed: new Promise((resolve) => child.once('close', resolve)) })
      return child
    },
    probePresence: (pid) => process.kill(pid, 0),
  }
  const result = await runProducerProof({ ...proofOptions, adapter })
  const retained = result.evidence.cleanup.retainedRoot
  t.after(async () => {
    for (const { child, closed } of processes) {
      await closed
      if (child.pid && process.platform !== 'win32') {
        for (const id of [child.pid, -child.pid])
          assert.throws(() => process.kill(id, 0), { code: 'ESRCH' })
      }
    }
    if (retained) await rm(retained, { recursive: true })
  })
  assert.deepEqual(calls[0], [leaseBuildScript])
  if (buildCode) assert.equal(calls.length, 1)
  return result
}

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

test('a failed helper build stops Codex before installing the package', async (t) => {
  const { evidence } = await runFakeProof(t, {
    buildCode: 1,
    npm: '/unused/npm',
    pnpm: '/unused/pnpm',
  })
  assert.equal(evidence.classification, 'setup-unavailable')
  assert.match(evidence.detail, /helper build exited 1/)
  assert.equal(evidence.cleanup.rootRemoved, true)
})

test('native producer runner reports install failure as unavailable setup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-install-'))
  try {
    const npm = join(root, 'npm')
    await writeFile(npm, '#!/bin/sh\nexit 17\n', { mode: 0o755 })
    const result = await runFakeProof(t, { npm, pnpm: 'unused' })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'setup-unavailable')
    assert.equal(result.evidence.version, null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('native producer runner distinguishes wrong installed CLI version', async (t) => {
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
    const result = await runFakeProof(t, { npm, pnpm: 'unused' })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'observed-contract-error')
    assert.equal(result.evidence.version, 'codex-cli 9.9.9')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('nonzero version probe is setup unavailable, not a version mismatch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-version-launch-'))
  try {
    const npm = join(root, 'npm-fixture.mjs')
    await writeFile(
      npm,
      `#!/usr/bin/env node\nimport { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path'; const dir = join(process.argv[process.argv.indexOf('--prefix') + 1], 'node_modules', '@openai', 'codex'); await mkdir(join(dir, 'bin'), { recursive: true }); await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.169.0' })); await writeFile(join(dir, 'bin', 'codex.js'), 'process.exit(1)\\n')`,
      { mode: 0o755 },
    )
    const result = await runFakeProof(t, { npm, pnpm: 'unused' })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'setup-unavailable')
    assert.equal(result.evidence.version, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zero-exit fake Vitest without a native artifact is never proof', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-empty-'))
  try {
    const npm = await installFixture(root)
    const pnpm = await pnpmFixture(
      root,
      'process.stdout.write("Test Files 1 passed\\nTests 0 passed (0)\\n")',
    )
    const result = await runFakeProof(t, { npm, pnpm })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'incomplete-proof')
    assert.equal(result.evidence.cleanup.rootRemoved, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zero-test and skipped-test runner output cannot pass', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-skipped-'))
  try {
    const npm = await installFixture(root)
    const pnpm = await pnpmFixture(
      root,
      'process.stdout.write(process.env.HOLI_CODEX_PROOF_OUTPUT ? "Test Files 1 passed\\nTests 5 skipped (5)\\n" : "")',
    )
    const result = await runFakeProof(t, { npm, pnpm })
    assert.equal(result.failed, true)
    assert.equal(result.evidence.classification, 'incomplete-proof')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('all native contract failures are classified from explicit scenario evidence', async (t) => {
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
    const result = await runFakeProof(t, { npm, pnpm })
    assert.equal(result.evidence.classification, 'incomplete-proof')
    assert.equal(result.evidence.firstFailure, 'observed-contract-error')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('preserves a late setup failure when worker cleanup is incomplete', async (t) => {
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
    const result = await runFakeProof(t, { npm, pnpm })
    assert.equal(result.evidence.classification, 'incomplete-proof')
    assert.equal(result.evidence.firstFailure, 'setup-unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('malformed, partial, oversized and unknown native proof are rejected', async (t) => {
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
      const result = await runFakeProof(t, { npm, pnpm })
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

test('retains evidence on early runner exit without signalling a matching detached child', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-owned-fixture-'))
  // This child belongs to the test, not the runner. Its argv can be made to
  // match the installed package without giving the runner authority over it.
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    process.on('message', (argv) => { process.title = argv; process.send('ready') })
    process.on('disconnect', () => process.exit(0))
  `,
    ],
    { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  // The IPC descriptor is closed by our disconnect; join the actual child exit.
  const exited = once(child, 'exit')
  const pid = child.pid
  let result
  try {
    const npm = await installFixture(root)
    // Observe the outer-installed package path without starting a real CLI.
    const pnpm = await pnpmFixture(
      root,
      `
      const fs = await import('node:fs/promises')
      await fs.writeFile(process.env.HOLI_CODEX_PROCESS_LEDGER, JSON.stringify({ pid: ${pid}, bin: process.env.HOLI_CODEX_BIN }))
      await fs.writeFile(${JSON.stringify(join(root, 'bin'))}, process.env.HOLI_CODEX_BIN)
      while (!(await fs.stat(${JSON.stringify(join(root, 'ready'))}).catch(() => null)))
        await new Promise((resolve) => setTimeout(resolve, 10))
      process.exit(7)
    `,
    )
    const pending = runFakeProof(t, { npm, pnpm })
    try {
      const until = Date.now() + 3000
      let bin
      while (!bin && Date.now() < until) {
        bin = await readFile(join(root, 'bin'), 'utf8').catch(() => undefined)
        if (!bin) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(bin)
      const ready = once(child, 'message', { signal: AbortSignal.timeout(3000) })
      child.send(bin)
      await ready
    } finally {
      await writeFile(join(root, 'ready'), '')
      result = await pending
    }
    assert.equal(child.connected, true)
    assert.equal(result.evidence.cleanup.status, 'incomplete')
    assert.match(result.evidence.detail, /exited 7/)
    assert.ok(existsSync(join(result.evidence.cleanup.retainedRoot, 'native-processes.jsonl')))
  } finally {
    if (child.connected) child.disconnect()
    await exited
    if (process.platform !== 'win32') {
      for (const id of [pid, -pid]) assert.throws(() => process.kill(id, 0), { code: 'ESRCH' })
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('timeout scenario evidence remains incomplete instead of a contract mismatch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-timeout-classification-'))
  try {
    const npm = await installFixture(root)
    const scenarios = [
      {
        name: 'initial-turn',
        stage: 'host-lifecycle',
        status: 'unverified',
        failureKind: 'timeout',
        failure: 'native job did not settle',
      },
      ...['follow-up', 'http-400', 'stall-stop', 'stall-leave'].map((name) => ({
        name,
        stage: 'setup',
        status: 'unverified',
        failureKind: 'setup',
      })),
    ]
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
      `import { writeFile } from 'node:fs/promises'; const proof = ${JSON.stringify(artifact)}; proof.bin = process.env.HOLI_CODEX_BIN; await writeFile(process.env.HOLI_CODEX_PROOF_OUTPUT, JSON.stringify(proof)); process.stdout.write('1 failed')`,
    )
    const result = await runFakeProof(t, { npm, pnpm })
    assert.equal(result.evidence.classification, 'incomplete-proof')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('bounded-out raw native evidence stays incomplete despite a mismatch artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-native-output-limit-'))
  try {
    const npm = await installFixture(root)
    const scenarios = [
      {
        name: 'initial-turn',
        stage: 'host-lifecycle',
        status: 'mismatch',
        failureKind: 'contract',
        failure: 'native job timed out',
        rawProcesses: [{ outputLimited: true }],
      },
      ...['follow-up', 'http-400', 'stall-stop', 'stall-leave'].map((name) => ({
        name,
        stage: 'setup',
        status: 'unverified',
        failureKind: 'setup',
      })),
    ]
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
      `import { writeFile } from 'node:fs/promises'; const proof = ${JSON.stringify(artifact)}; proof.bin = process.env.HOLI_CODEX_BIN; await writeFile(process.env.HOLI_CODEX_PROOF_OUTPUT, JSON.stringify(proof)); process.stdout.write('1 failed')`,
    )
    const result = await runFakeProof(t, { npm, pnpm })
    assert.equal(result.evidence.classification, 'incomplete-proof')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('output cap and deadline preserve the initiating failure and retain the root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-bounds-'))
  try {
    const npm = await installFixture(root)
    const noisy = await pnpmFixture(root, 'process.stdout.write("x".repeat(2 * 1024 * 1024 + 10))')
    const capped = await runFakeProof(t, { npm, pnpm: noisy })
    assert.equal(capped.evidence.classification, 'incomplete-proof')
    assert.equal(capped.evidence.cleanup.status, 'incomplete')
    assert.match(capped.evidence.detail, /output exceeded bound/)
    assert.ok(capped.evidence.test.retainedBytes <= 2 * 1024 * 1024)

    const resistant = await pnpmFixture(
      root,
      `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`,
    )
    const expired = await runFakeProof(t, { npm, pnpm: resistant, timeout: 2_000 })
    assert.equal(expired.evidence.classification, 'incomplete-proof')
    assert.equal(expired.evidence.test.timedOut, true)
    assert.equal(expired.evidence.cleanup.status, 'incomplete')
    assert.match(expired.evidence.detail, /timed out/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex only removes the root after the final worker lease settlement receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'holi-producer-final-receipt-'))
  try {
    const npm = await installFixture(root)
    for (const mode of ['pending', 'leftover', 'finished']) {
      const pnpm = await pnpmFixture(
        root,
        `
        import { mkdir, writeFile } from 'node:fs/promises'
        import { join } from 'node:path'
        const mode = ${JSON.stringify(mode)}
        const proof = {
          schema: 'holi.codex-exec-producer.v1', bin: process.env.HOLI_CODEX_BIN,
          scenarios: ['initial-turn', 'follow-up', 'http-400', 'stall-stop', 'stall-leave']
            .map((name) => ({ name, status: mode === 'pending' && name === 'stall-leave' ? 'pending' : 'pass' })),
          cleanup: { rootsRemoved: true, nativeGroupsDrained: true },
        }
        if (mode === 'leftover') await mkdir(join(process.env.TMPDIR, 'holi-native-codex-leftover'))
        await writeFile(process.env.HOLI_CODEX_PROOF_OUTPUT, JSON.stringify(proof))
        console.log('5 passed')
      `,
      )
      const { evidence } = await runFakeProof(t, { npm, pnpm })
      assert.equal(evidence.cleanup.rootRemoved, mode === 'finished', mode)
      if (mode !== 'finished') assert.ok(existsSync(evidence.cleanup.retainedRoot))
      assert.equal(
        evidence.classification,
        'incomplete-proof',
        'receipt is not native contract proof',
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
