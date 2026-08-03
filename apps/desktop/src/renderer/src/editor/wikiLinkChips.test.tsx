import { describe, expect, it } from 'vitest'
import { WikiLinkChip } from './wikiLinkChips'

describe('WikiLinkChip', () => {
  it('a task chip carries the path, an orb, and strikes when done', () => {
    const el = new WikiLinkChip('p/task.a.md', 'Fix login', true, { status: 'done' }).toDOM()
    expect(el.dataset['wikiTarget']).toBe('p/task.a.md')
    expect(el.classList.contains('cm-wikilink-task')).toBe(true)
    expect(el.classList.contains('cm-wikilink-done')).toBe(true)
    expect(el.querySelector('.cm-task-orb-done')).not.toBeNull()
    expect(el.textContent).toBe('Fix login')
  })

  it('a doing task chip has an orb but no strike', () => {
    const el = new WikiLinkChip('p/task.a.md', 'Fix login', true, { status: 'doing' }).toDOM()
    expect(el.querySelector('.cm-task-orb-doing')).not.toBeNull()
    expect(el.classList.contains('cm-wikilink-done')).toBe(false)
  })

  it('a missing note chip carries the path and the missing class, no orb', () => {
    const el = new WikiLinkChip('notes/gone.md', 'notes/gone.md', false).toDOM()
    expect(el.dataset['wikiTarget']).toBe('notes/gone.md')
    expect(el.classList.contains('cm-wikilink-missing')).toBe(true)
    expect(el.querySelector('.cm-task-orb')).toBeNull()
  })
})
