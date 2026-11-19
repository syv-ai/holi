import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  observeChild,
  startupDiagnostic,
  stopOwnedCommunityFixture,
} from './native-smoke-process.mjs'

test('captures a child exit before any CDP connection exists', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(17)'])
  const state = observeChild(child)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000)
  const exit = await state.closed
  clearTimeout(timeout)

  assert.deepEqual(exit, { code: 17, signal: null })
  assert.match(startupDiagnostic('DevTools', state, 'early exit'), /code":17/)
  assert.match(startupDiagnostic('DevTools', state, 'early exit'), /early exit/)
})

test('fixture cleanup verifies the requested filename and refuses a foreign PID', async () => {
  const installedCode = await mkdtemp(join(tmpdir(), 'holi-fixture-cleanup-'))
  try {
    await writeFile(join(installedCode, '.hint-smoke-pid'), String(process.pid))

    const signals = []
    await assert.rejects(
      stopOwnedCommunityFixture({
        installedCode,
        pluginPort: 4321,
        filename: 'slides.fixture',
        sleep: async () => {},
        run: (command) =>
          command === 'ps'
            ? `${process.execPath} serve.cjs slides.md --port 4321`
            : `p${installedCode}`,
        signal: (pid, value) => {
          signals.push(value)
          return process.kill(pid, value)
        },
      }),
      /refusing to signal unverified fixture PID/,
    )
    assert.deepEqual(signals, [0])
  } finally {
    await rm(installedCode, { recursive: true, force: true })
  }
})

test('reports spawn failure before CDP without waiting for a timeout', async () => {
  const child = spawn('/no/such/holi-native-smoke-executable', [])
  const state = observeChild(child)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000)
  await state.closed
  clearTimeout(timeout)

  assert.match(state.spawnFailure, /ENOENT/)
  assert.match(startupDiagnostic('DevTools', state, ''), /ENOENT/)
})
