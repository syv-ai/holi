import { describe, expect, it } from 'vitest'
import { WikiLinkChip } from './wikiLinkChips'

describe('WikiLinkChip', () => {
  it('a claimed chip carries the path, its orb, and strikes when its claim says', () => {
    const el = new WikiLinkChip('p/a.md', 'Fix login', true, {
      orb: 'red',
      struck: true,
    }).toDOM()
    expect(el.dataset['wikiTarget']).toBe('p/a.md')
    expect(el.classList.contains('cm-wikilink-claimed')).toBe(true)
    expect(el.classList.contains('cm-wikilink-done')).toBe(true)
    expect(el.querySelector<HTMLElement>('.cm-link-orb')?.style.background).toBe('red')
    expect(el.textContent).toBe('Fix login')
  })

  it('a claimed chip that is not struck has its orb and no strike', () => {
    const el = new WikiLinkChip('p/a.md', 'Fix login', true, { orb: 'red' }).toDOM()
    expect(el.querySelector('.cm-link-orb')).not.toBeNull()
    expect(el.classList.contains('cm-wikilink-done')).toBe(false)
  })

  it('a missing note chip carries the path and the missing class, no orb', () => {
    const el = new WikiLinkChip('notes/gone.md', 'notes/gone.md', false).toDOM()
    expect(el.dataset['wikiTarget']).toBe('notes/gone.md')
    expect(el.classList.contains('cm-wikilink-missing')).toBe(true)
    expect(el.querySelector('.cm-link-orb')).toBeNull()
  })
})
