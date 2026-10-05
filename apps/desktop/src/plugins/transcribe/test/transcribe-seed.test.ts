import { describe, expect, it } from 'vitest'
import { TRANSCRIBE_INFO } from '../info'
import { transcribeSeed } from '../main/seed'

describe('Transcribe seed', () => {
  it('is the plugin of its id, off unless a vault turns it on', () => {
    expect(transcribeSeed.id).toBe(TRANSCRIBE_INFO.id)
    expect(TRANSCRIBE_INFO.default).toBe(false)
  })

  it('seeds the bundle once, under a .local. name, and never any records', () => {
    expect(Object.keys(transcribeSeed.once).sort()).toEqual([
      'Transcribe.local.app/app.js',
      'Transcribe.local.app/app.yaml',
      'Transcribe.local.app/index.html',
      'Transcribe.local.app/style.css',
    ])
    expect(transcribeSeed.shipped).toEqual({})
  })

  it('asks for the microphone and the network, and names its one host', () => {
    const manifest = transcribeSeed.once['Transcribe.local.app/app.yaml'] as string
    expect(manifest).toMatch(/^ {2}recording: /m)
    expect(manifest).toMatch(/^ {2}network: /m)
    expect(manifest).toMatch(/^hosts: \[platform\.syv\.ai\]$/m)
  })

  it('carries no key of its own', () => {
    const all = Object.values(transcribeSeed.once).join('\n')
    expect(all).not.toMatch(/Bearer [A-Za-z0-9]{12,}/)
  })
})
