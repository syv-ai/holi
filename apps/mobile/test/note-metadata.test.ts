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
    const allPaths = Array.from({ length: 52 }, (_, i) => `notes/${i}.md`)
    const visible = [...allPaths, 'renamed/50.md', 'renamed/0.md']
    expect(restarted.visible(visible).recents).toEqual([
      'renamed/50.md',
      'notes/51.md',
      ...Array.from({ length: 48 }, (_, i) => `notes/${49 - i}.md`),
    ])
    expect(restarted.visible(visible).favourites).toEqual(['notes/0.md'])
    restarted.move('notes/0.md', 'renamed/0.md')
    expect(restarted.visible(visible).favourites).toEqual(['renamed/0.md'])
    restarted.remove('renamed/0.md')
    restarted.remove('renamed/50.md')
    const removed = createNoteMetadata(settings, 'owner/a').visible(visible)
    expect(removed.recents).not.toContain('renamed/50.md')
    expect(removed.favourites).toEqual([])
    expect(createNoteMetadata(settings, 'owner/b').visible(visible)).toEqual({
      recents: [],
      favourites: [],
    })
    expect(restarted.visible(['notes/51.md', '../escape.md', '.env.md', 'image.png'])).toEqual({
      recents: ['notes/51.md'],
      favourites: [],
    })
  })

  it('preserves malformed stored data and rejects invalid identities and paths', () => {
    const settings = new Settings()
    for (const stored of [
      '{broken',
      JSON.stringify({ recents: 'notes/a.md', favourites: [] }),
      JSON.stringify({ recents: [42], favourites: [] }),
    ]) {
      settings.values.set('holi.note-metadata:owner/repo', stored)
      expect(() => createNoteMetadata(settings, 'owner/repo')).toThrow()
      expect(settings.values.get('holi.note-metadata:owner/repo')).toBe(stored)
    }
    expect(() => createNoteMetadata(settings, 'not a remote')).toThrow()

    const validSettings = new Settings()
    const metadata = createNoteMetadata(validSettings, 'owner/repo')
    metadata.recent('notes/before.md')
    const before = validSettings.values.get('holi.note-metadata:owner/repo')
    for (const path of [
      '.env.md',
      '.git/note.md',
      'notes/local.local.md',
      '.holi/settings/app.yaml',
      '.holi-storage-stage/note.md',
    ]) {
      expect(() => metadata.recent(path)).toThrow()
      expect(validSettings.values.get('holi.note-metadata:owner/repo')).toBe(before)
    }
    expect(metadata.visible(['notes/before.md']).recents).toEqual(['notes/before.md'])
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
