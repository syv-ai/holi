import { beforeEach, describe, expect, it } from 'vitest'
import { ThemeApplicator } from '../theme-applicator'

// Pure DOM logic — a bare element, no React, no jotai, no tRPC. This is the
// point of extracting the applicator: the fiddly diff/clear is testable on its
// own, and the hook test (state/__tests__/theme.test.tsx) only has to prove the
// wiring.
describe('ThemeApplicator', () => {
  let root: HTMLElement
  beforeEach(() => {
    root = document.createElement('div')
  })

  it('applies vars as custom properties', () => {
    new ThemeApplicator(root).apply({ '--primary': '#f00', '--radius': '1rem' })
    expect(root.style.getPropertyValue('--primary')).toBe('#f00')
    expect(root.style.getPropertyValue('--radius')).toBe('1rem')
  })

  it('on re-apply, removes properties no longer present and overwrites the rest', () => {
    const a = new ThemeApplicator(root)
    a.apply({ '--primary': '#f00', '--radius': '1rem' })
    a.apply({ '--primary': '#0f0' })
    expect(root.style.getPropertyValue('--primary')).toBe('#0f0')
    expect(root.style.getPropertyValue('--radius')).toBe('') // dropped
  })

  it('clear() removes everything it set', () => {
    const a = new ThemeApplicator(root)
    a.apply({ '--primary': '#f00', '--radius': '1rem' })
    a.clear()
    expect(root.style.getPropertyValue('--primary')).toBe('')
    expect(root.style.getPropertyValue('--radius')).toBe('')
  })

  it('only touches properties it set, leaving foreign ones alone', () => {
    root.style.setProperty('--not-mine', 'keep')
    const a = new ThemeApplicator(root)
    a.apply({ '--primary': '#f00' })
    a.clear()
    expect(root.style.getPropertyValue('--not-mine')).toBe('keep')
  })
})
