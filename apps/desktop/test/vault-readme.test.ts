import { describe, expect, it } from 'vitest'
import { vaultReadme } from '../src/main/vault/readme'

describe('vaultReadme', () => {
  it('opens with the vault name and carries the answer as its own paragraph', () => {
    const text = vaultReadme('kunder', '  Customer work for the team.  ')
    const lines = text.split('\n')
    expect(lines[0]).toBe('# kunder')
    expect(lines.slice(1, 3)).toEqual(['', 'Customer work for the team.'])
    expect(text).toMatch(/\n## Folders\n/)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('leaves the paragraph out when the question was skipped', () => {
    expect(vaultReadme('kunder', '   ')).toBe(vaultReadme('kunder'))
    expect(vaultReadme('kunder').split('\n').slice(0, 3)).toEqual(['# kunder', '', '## Folders'])
  })
})
