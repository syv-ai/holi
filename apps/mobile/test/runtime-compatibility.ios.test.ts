import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  report: '',
}))

vi.mock('@nativescript/core', () => ({
  Device: { osVersion: 'test-os' },
  File: {
    fromPath: () => ({
      writeTextSync: (text: string, onError: (error: Error | null) => void) => {
        state.report = text
        onError(null)
      },
    }),
  },
  knownFolders: {
    documents: () => ({ path: '/test/documents' }),
    ios: { library: () => ({ path: '/test/library' }) },
  },
  path: { join: (...parts: string[]) => parts.join('/') },
}))
vi.mock('../app/note-metadata', () => ({
  createNoteMetadata: () => {
    throw new Error('controlled storage failure')
  },
}))
vi.mock('../app/note-metadata-settings.ios', () => ({ noteMetadataSettings: {} }))
vi.mock('@holi/shared/vault-format', () => ({
  runVaultFormatCorpus: () => ({ passed: 1, total: 1, failed: 0 }),
}))
vi.mock('../app/native-files.ios', () => ({ createNativeFiles: () => ({}), nativeFiles: {} }))
vi.mock('../app/vault-storage-check', () => ({ runVaultStorageCheck: vi.fn() }))
vi.mock('../app/native-posix.ios', () => ({ nativeIO: {} }))
vi.mock('../app/vault-storage', () => ({ createVaultStorage: vi.fn() }))
vi.mock('../app/storage-staging', () => ({ stagingDirectory: vi.fn() }))
vi.mock('../app/storage-restart.ios', () => ({ runRestartPhase: vi.fn() }))
vi.mock('../app/move-restart.ios', () => ({ runMoveRestart: vi.fn() }))
vi.mock('../app/compatibility-check.ios', () => ({ runGitCompatibilityCheck: vi.fn() }))
vi.mock('../app/working-copy-check.ios', () => ({ runWorkingCopyCheck: vi.fn() }))

import { checkCompatibility } from '../app/runtime.ios'

afterEach(() => {
  vi.unstubAllGlobals()
  state.report = ''
})

it('persists observed native availability alongside a later compatibility failure', async () => {
  vi.stubGlobal('NSProcessInfo', {
    processInfo: {
      environment: {
        objectForKey: (key: string) =>
          key === 'HOLI_COMPAT_RUN_ID' ? '79700000-0000-4000-8000-000000000001' : null,
      },
    },
  })
  const availabilityReason = vi.fn(() => 'available')
  vi.stubGlobal('HoliFoundationModels', { availabilityReason })

  await checkCompatibility()
  const report = JSON.parse(state.report)
  expect(report.foundationModels).toBe('available')
  expect(report.failure).toEqual({
    phase: 'note-metadata',
    operation: 'persist/reconstruct/remove',
  })
  expect(availabilityReason).toHaveBeenCalledOnce()
})

it('does not query model availability during recovery and persists missing or malformed native results as errors', async () => {
  vi.stubGlobal('NSProcessInfo', {
    processInfo: {
      environment: {
        objectForKey: (key: string) =>
          key === 'HOLI_STORAGE_PHASE'
            ? 'recovery'
            : key === 'HOLI_COMPAT_RUN_ID'
              ? '79700000-0000-4000-8000-000000000001'
              : null,
      },
    },
  })
  const availabilityReason = vi.fn(() => 'available')
  vi.stubGlobal('HoliFoundationModels', { availabilityReason })
  await checkCompatibility()
  expect(availabilityReason).not.toHaveBeenCalled()
  expect(JSON.parse(state.report)).toMatchObject({
    phase: 'recovery',
    failure: { phase: 'note-metadata', operation: 'persist/reconstruct/remove' },
  })

  for (const integration of [undefined, { availabilityReason: () => 'not-a-reason' }]) {
    if (integration) vi.stubGlobal('HoliFoundationModels', integration)
    else Reflect.deleteProperty(globalThis, 'HoliFoundationModels')
    // Normal launch must reach native integration validation before the later storage failure.
    vi.stubGlobal('NSProcessInfo', {
      processInfo: {
        environment: {
          objectForKey: (key: string) =>
            key === 'HOLI_COMPAT_RUN_ID' ? '79700000-0000-4000-8000-000000000001' : null,
        },
      },
    })
    await checkCompatibility()
    const report = JSON.parse(state.report)
    expect(report.error).toBeTruthy()
    expect(report.failure).toEqual({
      phase: 'foundation-models-availability',
      operation: 'foundationModelsAvailability',
    })
    expect(report.foundationModels).toBeUndefined()
  }
})
