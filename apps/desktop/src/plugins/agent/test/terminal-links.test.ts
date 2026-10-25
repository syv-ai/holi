import { describe, expect, it } from 'vitest'
import { vaultLinks } from '../renderer/lib/terminal-links'
import { contextLine, withContext } from '../renderer/state/session-view'

const ROOT = '/Users/ada/Holi/syv/vault'
const FILES = new Set(['Planning/Q4.md', 'notes/a.md', 'apps/crm/app.yaml'])
const has = (p: string) => FILES.has(p)

describe('vault paths in terminal output', () => {
  it('links the paths the vault has, where they are in the line', () => {
    const line = '  Editing Planning/Q4.md (+3) and notes/b.md'
    expect(vaultLinks(line, has, ROOT)).toEqual([
      { path: 'Planning/Q4.md', start: 10, end: 24 },
    ])
  })

  it('reads an absolute path inside the clone, and ./, but nothing outside', () => {
    expect(vaultLinks(`Read ${ROOT}/notes/a.md`, has, ROOT).map((l) => l.path)).toEqual([
      'notes/a.md',
    ])
    expect(vaultLinks('see ./notes/a.md:12.', has, ROOT)).toEqual([
      { path: 'notes/a.md', start: 4, end: 16 },
    ])
    expect(vaultLinks('/etc/notes/a.md ../notes/a.md', has, ROOT)).toEqual([])
  })

  it('does not link part of a longer word', () => {
    expect(vaultLinks('xnotes/a.md', has, ROOT)).toEqual([])
  })
})

describe('a first message about an app', () => {
  const app = { kind: 'app' as const, path: 'apps/crm', name: 'CRM' }

  it('names the app ahead of the ask', () => {
    expect(withContext('Add a column', [app])).toBe(`${contextLine(app)}\n\nAdd a column`)
    expect(withContext('Add a column', undefined)).toBe('Add a column')
    expect(withContext('', [app])).toBe(contextLine(app))
  })
})
