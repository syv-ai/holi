import { beforeEach, expect, it, vi } from 'vitest'
import { createNoteMetadata } from '../app/note-metadata'
import { noteMetadataSettings } from '../app/note-metadata-settings.ios'

const settings = vi.hoisted(() => ({ cache: new Map<string, string>(), fail: false }))
vi.mock('@nativescript/core/application-settings', () => ({
  getString: (key: string) => settings.cache.get(key),
  setString: (key: string, value: string) => settings.cache.set(key, value),
  remove: (key: string) => settings.cache.delete(key),
  flush: () => !settings.fail,
}))

beforeEach(() => {
  settings.cache.clear()
  settings.fail = false
})

it('reconstructs metadata after successful native settings writes', () => {
  createNoteMetadata(noteMetadataSettings, 'owner/vault').recent('a.md')
  expect(createNoteMetadata(noteMetadataSettings, 'owner/vault').visible(['a.md']).recents).toEqual(
    ['a.md'],
  )
})

it.each([false, true])('preserves state and cache on failed flush, existing key: %s', (exists) => {
  const metadata = createNoteMetadata(noteMetadataSettings, 'owner/vault')
  if (exists) metadata.recent('a.md')
  const stored = new Map(settings.cache)
  settings.fail = true
  expect(() => metadata.recent('b.md')).toThrow()
  expect(settings.cache).toEqual(stored)
  const expected = exists ? ['a.md'] : []
  expect(metadata.visible(['a.md', 'b.md']).recents).toEqual(expected)
  expect(
    createNoteMetadata(noteMetadataSettings, 'owner/vault').visible(['a.md', 'b.md']).recents,
  ).toEqual(expected)
})
