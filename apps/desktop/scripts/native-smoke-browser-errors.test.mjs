import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertNoBrowserRuntimeErrors,
  isBrowserRuntimeError,
} from './native-smoke-browser-errors.mjs'

test('browser runtime errors capture exceptions and error-level console calls only', () => {
  assert.equal(isBrowserRuntimeError({ method: 'Runtime.exceptionThrown' }), true)
  assert.equal(
    isBrowserRuntimeError({
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error' },
    }),
    true,
  )
  for (const type of ['log', 'info', 'warning', 'debug', 'dir'])
    assert.equal(
      isBrowserRuntimeError({ method: 'Runtime.consoleAPICalled', params: { type } }),
      false,
      `${type} console calls are ordinary logs`,
    )
  assert.equal(isBrowserRuntimeError({ method: 'Page.loadEventFired' }), false)
})

test('renderer exception collection fails the smoke while a clean collection passes', () => {
  assert.throws(
    () => assertNoBrowserRuntimeErrors([{ method: 'Runtime.exceptionThrown' }]),
    /renderer emitted uncaught exceptions or console.error calls/,
  )
  assert.throws(
    () =>
      assertNoBrowserRuntimeErrors([
        { method: 'Runtime.consoleAPICalled', params: { type: 'error' } },
      ]),
    /renderer emitted uncaught exceptions or console.error calls/,
  )
  assert.doesNotThrow(() => assertNoBrowserRuntimeErrors([]))
})
