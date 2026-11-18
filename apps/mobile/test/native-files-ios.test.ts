import { afterEach, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  canonical: vi.fn((path: string) => path),
  names: vi.fn((path: string) => (path === '/vault' ? ['source.md', 'TARGET.md'] : [])),
  kind: vi.fn((path: string) => {
    if (path === '/vault/source.md') return 'regular'
    if (path === '/vault/TARGET.md') return 'symlink'
    if (path === '/vault/target.md') return null
    return 'directory'
  }),
  read: vi.fn(() => new Uint8Array([115, 111, 117, 114, 99, 101])),
  mkdir: vi.fn(),
  syncDirectory: vi.fn(),
  syncFile: vi.fn(),
  writeExclusive: vi.fn(),
  publish: vi.fn(),
  removeFile: vi.fn(),
}))

vi.mock('@nativescript/core', () => ({
  knownFolders: { ios: { library: () => ({ path: '/library' }) } },
}))
vi.mock('../app/native-posix.ios', () => ({ nativeIO: io }))

import { createNativeFiles } from '../app/native-files.ios'
import { createVaultStorage } from '../app/vault-storage'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('preflights a hidden symlink spelling alias before recording a native move', async () => {
  vi.stubGlobal('NSString', {
    stringWithString: (value: string) => ({
      precomposedStringWithCanonicalMapping: value.normalize('NFC'),
    }),
  })
  vi.stubGlobal('NSUUID', {
    UUID: () => ({ UUIDString: '00000000-0000-4000-8000-000000000001' }),
  })
  const adapter = createNativeFiles()
  const publishJournal = vi.spyOn(adapter, 'privatePublish')
  const store = createVaultStorage(adapter, { remote: 'holi/native-alias', root: '/vault' })
  const source = await store.read('source.md')

  await expect(adapter.readOptional('/vault', 'target.md')).rejects.toThrow(
    'Filesystem spelling collision',
  )
  await expect(store.move('source.md', 'target.md', source.revision)).rejects.toThrow(
    'Filesystem spelling collision',
  )
  expect(publishJournal).not.toHaveBeenCalled()
  expect(io.writeExclusive).not.toHaveBeenCalled()
  expect(io.publish).not.toHaveBeenCalled()
  expect(io.removeFile).not.toHaveBeenCalled()
  expect((await store.read('source.md')).bytes).toEqual(source.bytes)
})

it.each([
  {
    label: 'source file hidden by a differently-cased symlink',
    rootNames: ['source.md', 'SOURCE.md'],
    target: 'target.md',
    targetKinds: new Set<string>(),
    aliasPath: '/vault/SOURCE.md',
  },
  {
    label: 'destination parent with a differently-cased sibling',
    rootNames: ['source.md', 'Folder', 'FOLDER'],
    target: 'Folder/moved.md',
    targetKinds: new Set<string>(['/vault/Folder', '/vault/FOLDER']),
    aliasPath: '/vault/FOLDER',
  },
])('preflights move aliases in every component: $label', async (scenario) => {
  vi.stubGlobal('NSString', {
    stringWithString: (value: string) => ({
      precomposedStringWithCanonicalMapping: value.normalize('NFC'),
    }),
  })
  vi.stubGlobal('NSUUID', {
    UUID: () => ({ UUIDString: '00000000-0000-4000-8000-000000000001' }),
  })
  io.names.mockImplementation((path) => {
    if (path === '/vault') return scenario.rootNames
    if (path === '/vault/Folder') return []
    return []
  })
  io.kind.mockImplementation((path) => {
    if (path === '/vault/source.md') return 'regular'
    if (path === scenario.aliasPath) return scenario.targetKinds.has(path) ? 'directory' : 'symlink'
    if (scenario.targetKinds.has(path)) return 'directory'
    return null
  })
  io.read.mockImplementation(() => new Uint8Array([115, 111, 117, 114, 99, 101]))

  const adapter = createNativeFiles()
  const publishJournal = vi.spyOn(adapter, 'privatePublish')
  const store = createVaultStorage(adapter, { remote: 'holi/native-alias', root: '/vault' })
  const source = await store.read('source.md')
  expect(source.bytes).toEqual(new Uint8Array([115, 111, 117, 114, 99, 101]))
  expect(await store.list()).toContain('source.md')

  await expect(store.move('source.md', scenario.target, source.revision)).rejects.toThrow(
    'Filesystem spelling collision',
  )
  expect(publishJournal).not.toHaveBeenCalled()
  expect(io.writeExclusive).not.toHaveBeenCalled()
  expect(io.publish).not.toHaveBeenCalled()
  expect(io.removeFile).not.toHaveBeenCalled()
  expect((await store.read('source.md')).bytes).toEqual(source.bytes)
})
