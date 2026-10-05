import { describe, expect, it } from 'vitest'
import { NOTES_INFO } from '../info'
import { notesSeed } from '../main/seed'

describe('Notes seed', () => {
  it('is the plugin of its id, off unless a vault turns it on', () => {
    expect(notesSeed.id).toBe(NOTES_INFO.id)
    expect(NOTES_INFO.default).toBe(false)
  })

  it('seeds the Notes.app bundle once, and never any records', () => {
    expect(Object.keys(notesSeed.once).sort()).toEqual([
      'Notes.app/app.js',
      'Notes.app/app.yaml',
      'Notes.app/index.html',
      'Notes.app/style.css',
    ])
    expect(notesSeed.shipped).toEqual({})
  })

  it('has a manifest with a description and a notes collection', () => {
    const manifest = notesSeed.once['Notes.app/app.yaml'] as string
    expect(manifest).toMatch(/^description: .*notes/im)
    expect(manifest).toMatch(/^collections:\n {2}notes:/m)
  })
})
