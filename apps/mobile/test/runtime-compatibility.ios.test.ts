import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  report: '',
  failMetadata: true,
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
    if (state.failMetadata) throw new Error('controlled storage failure')
    return { recent: () => {}, visible: () => ({ recents: [] }), remove: () => {} }
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
  state.failMetadata = true
})

it('persists observed native availability alongside a later compatibility failure', async () => {
  vi.stubGlobal('NSProcessInfo', {
    processInfo: {
      environment: {
        objectForKey: (key: string) => (key === 'HOLI_COMPAT_RUN_ID' ? 'manual' : null),
      },
    },
  })
  const availabilityReason = vi.fn(() => 'available')
  vi.stubGlobal('HoliFoundationModels', { availabilityReason })

  const result = await checkCompatibility()
  const report = JSON.parse(state.report)
  expect(result).toContain('Compatibility failed')
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
              ? 'manual'
              : null,
      },
    },
  })
  const availabilityReason = vi.fn(() => 'available')
  vi.stubGlobal('HoliFoundationModels', { availabilityReason })
  await checkCompatibility()
  expect(availabilityReason).not.toHaveBeenCalled()

  for (const integration of [undefined, { availabilityReason: () => 'not-a-reason' }]) {
    if (integration) vi.stubGlobal('HoliFoundationModels', integration)
    else Reflect.deleteProperty(globalThis, 'HoliFoundationModels')
    // Normal phase calls the native diagnostic, then the controlled metadata failure persists the catch result.
    vi.stubGlobal('NSProcessInfo', {
      processInfo: {
        environment: {
          objectForKey: (key: string) => (key === 'HOLI_COMPAT_RUN_ID' ? 'manual' : null),
        },
      },
    })
    const result = await checkCompatibility()
    const report = JSON.parse(state.report)
    expect(result).toContain('Compatibility failed')
    expect(report.error).toBeTruthy()
    expect(report.foundationModels).toBeUndefined()
  }
})
