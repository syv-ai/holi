import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { observeChild, startupDiagnostic } from './native-smoke-process.mjs'

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

test('reports spawn failure before CDP without waiting for a timeout', async () => {
  const child = spawn('/no/such/holi-native-smoke-executable', [])
  const state = observeChild(child)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 2000)
  await state.closed
  clearTimeout(timeout)

  assert.match(state.spawnFailure, /ENOENT/)
  assert.match(startupDiagnostic('DevTools', state, ''), /ENOENT/)
})
