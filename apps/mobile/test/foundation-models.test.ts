import assert from 'node:assert/strict'
import { test } from 'vitest'
import { foundationModelsAvailability } from '../app/foundation-models.ios'

test('foundation model availability preserves native available and unavailable reasons', () => {
  for (const reason of [
    'available',
    'device-not-eligible',
    'apple-intelligence-not-enabled',
    'model-not-ready',
    'unknown',
  ]) {
    Object.defineProperty(globalThis, 'HoliFoundationModels', {
      configurable: true,
      value: { availabilityReason: () => reason },
    })
    assert.equal(foundationModelsAvailability(), reason)
  }
  delete (globalThis as typeof globalThis & { HoliFoundationModels?: unknown }).HoliFoundationModels
})

test('foundation model availability rejects missing integration and malformed native responses', () => {
  const host = globalThis as typeof globalThis & { HoliFoundationModels?: unknown }
  delete host.HoliFoundationModels
  assert.throws(() => foundationModelsAvailability())

  for (const native of [
    {},
    { availabilityReason: 1 },
    { availabilityReason: () => null },
    { availabilityReason: () => 'unexpected' },
  ]) {
    Object.defineProperty(globalThis, 'HoliFoundationModels', { configurable: true, value: native })
    assert.throws(() => foundationModelsAvailability())
  }
  Object.defineProperty(globalThis, 'HoliFoundationModels', {
    configurable: true,
    value: {
      availabilityReason: () => {
        throw new Error('native integration failure')
      },
    },
  })
  assert.throws(() => foundationModelsAvailability())
  delete host.HoliFoundationModels
})
