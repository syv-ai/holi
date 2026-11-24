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
  it('persists capped recency order, favourites, moves, removals, and vault isolation', () => {
    const settings = new Settings()
    const a = createNoteMetadata(settings, 'owner/a')
    for (let i = 0; i < 52; i++) a.recent(`notes/${i}.md`)
    a.recent('notes/50.md')
    a.setFavourite('notes/0.md', true)
    a.setFavourite('notes/1.md', true)
    a.setFavourite('notes/1.md', false)
    a.move('notes/50.md', 'renamed/50.md')
    const restarted = createNoteMetadata(settings, 'owner/a')
    expect(restarted.visible(['renamed/50.md', 'notes/51.md']).recents).toEqual([
      'renamed/50.md',
      'notes/51.md',
    ])
    expect(restarted.visible(['notes/0.md']).favourites).toEqual(['notes/0.md'])
    restarted.remove('renamed/50.md')
    expect(createNoteMetadata(settings, 'owner/a').visible(['renamed/50.md']).recents).toEqual([])
    expect(createNoteMetadata(settings, 'owner/b').visible(['notes/0.md']).favourites).toEqual([])
  })

  it('preserves malformed stored data and rejects invalid identities and paths', () => {
    const settings = new Settings()
    settings.values.set('holi.note-metadata:owner/repo', '{broken')
    expect(() => createNoteMetadata(settings, 'owner/repo')).toThrow()
    expect(settings.values.get('holi.note-metadata:owner/repo')).toBe('{broken')
    expect(() => createNoteMetadata(settings, 'not a remote')).toThrow()
    const metadata = createNoteMetadata(new Settings(), 'owner/repo')
    expect(() => metadata.recent('.env.md')).toThrow()
    expect(() => metadata.recent('.git/note.md')).toThrow()
  })

  it('keeps memory and persisted snapshots unchanged when writes fail', () => {
    const settings = new Settings()
    const metadata = createNoteMetadata(settings, 'owner/repo')
    metadata.recent('notes/before.md')
    const before = settings.values.get('holi.note-metadata:owner/repo')
    settings.set = () => {
      throw new Error('storage unavailable')
    }
    expect(() => metadata.recent('notes/after.md')).toThrow('storage unavailable')
    expect(metadata.visible(['notes/before.md', 'notes/after.md']).recents).toEqual([
      'notes/before.md',
    ])
    expect(settings.values.get('holi.note-metadata:owner/repo')).toBe(before)
  })
})
