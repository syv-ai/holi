import { afterEach, describe, expect, it } from 'vitest'
import { applyVaultTheme } from '../vault-theme'

afterEach(() => {
  document.documentElement.style.removeProperty('--primary')
  document.documentElement.style.removeProperty('--radius')
  document.documentElement.style.removeProperty('--unrelated')
})

describe('applyVaultTheme', () => {
  it('applies current mode tokens and removes stale ones without changing other root styles', () => {
    const root = document.documentElement
    root.style.setProperty('--unrelated', 'green')
    const old = applyVaultTheme(root, { primary: 'red', radius: '1rem' }, new Set())

    const next = applyVaultTheme(root, { primary: 'blue' }, old)

    expect(root.style.getPropertyValue('--primary')).toBe('blue')
    expect(root.style.getPropertyValue('--radius')).toBe('')
    expect(root.style.getPropertyValue('--unrelated')).toBe('green')
    expect(next).toEqual(new Set(['--primary']))
  })
})
