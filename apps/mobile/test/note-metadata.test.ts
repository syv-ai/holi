import { describe, expect, it } from 'vitest'
import { createNoteMetadata, type MetadataKeyValue } from '../app/note-metadata'

class Settings implements MetadataKeyValue {
  values = new Map<string, string>()
  get(key: string) {
    return this.values.get(key)
  }
  set(key: string, value: string) {
    this.values.set(key, value)
  }
}

describe('note metadata', () => {
  it('persists bounded ordered recents and favourites, isolates vaults, and filters visibility', () => {
    const settings = new Settings()
    const a = createNoteMetadata(settings, 'owner/a')
    for (let i = 0; i < 52; i++) a.recent(`notes/${i}.md`)
    a.setFavourite('notes/0.md', true)
    a.setFavourite('notes/1.md', true)
    a.move('notes/1.md', 'notes/0.md')
    const restarted = createNoteMetadata(settings, 'owner/a')
    expect(restarted.visible(['notes/0.md', 'notes/51.md']).recents).toEqual(['notes/51.md'])
    expect(restarted.visible(['notes/0.md']).favourites).toEqual(['notes/0.md'])
    expect(createNoteMetadata(settings, 'owner/b').visible(['notes/0.md']).favourites).toEqual([])
  })

  it('rejects invalid paths and leaves persisted state unchanged when writes fail', () => {
    const settings = new Settings()
    const metadata = createNoteMetadata(settings, 'owner/repo')
    expect(() => metadata.recent('.env.md')).toThrow()
    settings.set = () => {
      throw new Error('storage unavailable')
    }
    expect(() => metadata.recent('notes/a.md')).toThrow('storage unavailable')
    expect(metadata.visible([])).toEqual({ recents: [], favourites: [] })
  })
})
