import { describe, expect, it } from 'vitest'
import { vaultLinks } from '../renderer/lib/terminal-links'
import { contextLine, withContext } from '../renderer/state/session-view'

const ROOT = '/Users/ada/Holi/syv/vault'
const FILES = new Set(['Planning/Q4.md', 'notes/a.md', 'apps/crm/app.yaml'])
const has = (p: string) => FILES.has(p)

describe('vault paths in terminal output', () => {
  it('links the paths the vault has, where they are in the line', () => {
    const line = '  Editing Planning/Q4.md (+3) and notes/b.md'
    expect(vaultLinks(line, has, ROOT)).toEqual([{ path: 'Planning/Q4.md', start: 10, end: 24 }])
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

describe('vault paths in a terminal on Windows', () => {
  const WIN_ROOT = 'C:\\Users\\ada\\Holi\\syv\\vault'
  const FILES = new Set(['AGENTS.md', 'docs/guide.md', 'notes/a.md', 'src/a.ts'])
  const has = (p: string) => FILES.has(p)
  const paths = (line: string, root: string | null = WIN_ROOT) =>
    vaultLinks(line, has, root).map((l) => l.path)

  it('links an absolute path with backslashes, to the file it names', () => {
    expect(paths(`Read ${WIN_ROOT}\\docs\\guide.md`)).toEqual(['docs/guide.md'])
    expect(paths(`see ${WIN_ROOT}\\notes\\a.md:12`)).toEqual(['notes/a.md'])
  })

  it('does not link the vault-root file a longer path ends with', () => {
    expect(paths('Edited C:\\Users\\ada\\other\\AGENTS.md')).toEqual([])
    expect(paths('Edited D:\\docs\\AGENTS.md')).toEqual([])
    expect(paths('Edited ..\\docs\\AGENTS.md')).toEqual([])
    expect(paths(`Edited ${WIN_ROOT}-other\\AGENTS.md`)).toEqual([])
  })

  it('reads either slash, either drive-letter case, and the MSYS drive form', () => {
    expect(paths('Read C:/Users/ada/Holi/syv/vault/notes/a.md')).toEqual(['notes/a.md'])
    expect(paths('Read c:\\users\\ada\\holi\\syv\\vault\\notes\\a.md')).toEqual(['notes/a.md'])
    expect(paths('Read /c/Users/ada/Holi/syv/vault/notes/a.md')).toEqual(['notes/a.md'])
  })

  it('reads a relative path with backslashes or a leading .\\', () => {
    expect(paths('see src\\a.ts')).toEqual(['src/a.ts'])
    expect(paths('see .\\notes\\a.md')).toEqual(['notes/a.md'])
    expect(paths('see src/a.ts')).toEqual(['src/a.ts'])
  })

  it('links a path under a profile folder that holds a space', () => {
    const root = 'C:\\Users\\Ada Lovelace\\Holi\\syv\\vault'
    const line = `Read ${root}\\docs\\guide.md and C:\\Users\\Ada Lovelace\\other\\AGENTS.md`
    expect(vaultLinks(line, has, root)).toEqual([{ path: 'docs/guide.md', start: 5, end: 55 }])
    expect(paths(`see c:/users/ada lovelace/holi/syv/vault/notes/a.md:3`, root)).toEqual([
      'notes/a.md',
    ])
  })

  it('keeps each link where it is in the line', () => {
    expect(vaultLinks('see src\\a.ts now', has, WIN_ROOT)).toEqual([
      { path: 'src/a.ts', start: 4, end: 12 },
    ])
  })

  it('leaves the POSIX reading alone, backslash included', () => {
    const posixRoot = '/Users/ada/Holi/syv/vault'
    const only = (p: string) => p === 'a.ts'
    expect(vaultLinks('see src\\a.ts', only, posixRoot).map((l) => l.path)).toEqual(['a.ts'])
    expect(vaultLinks('see src/a.ts', has, null).map((l) => l.path)).toEqual(['src/a.ts'])
  })
})
