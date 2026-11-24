import { describe, expect, it } from 'vitest'
import { vaultPathIndex } from '@holi/shared'
import { planMoveInto } from '@/lib/tree-actions'
import {
  basename,
  expandToFiles,
  joinPath,
  parentOf,
  remapUnder,
  sourceInside,
  sourceName,
} from '@/lib/tree-paths'

describe('tree-paths', () => {
  it('joins, tolerating empty parent', () => {
    expect(joinPath('', 'a.md')).toBe('a.md')
    expect(joinPath('projects', 'a.md')).toBe('projects/a.md')
  })
  it('basename and parentOf', () => {
    expect(basename('projects/a.md')).toBe('a.md')
    expect(parentOf('projects/sub/a.md')).toBe('projects/sub')
    expect(parentOf('a.md')).toBe('')
  })
})

describe('tree-paths — folder & clipboard helpers', () => {
  const docs = ['inbox.md', 'projects/a.md', 'projects/sub/b.md']

  it('expandToFiles returns a file itself and every doc under a folder', () => {
    expect(expandToFiles(docs, 'inbox.md')).toEqual(['inbox.md'])
    expect(expandToFiles(docs, 'projects')).toEqual(['projects/a.md', 'projects/sub/b.md'])
    expect(expandToFiles(docs, 'empty')).toEqual([]) // transient folder, no docs
  })

  it('remapUnder rewrites the source prefix, preserving nested structure', () => {
    expect(remapUnder(docs, 'projects', 'work/projects')).toEqual([
      { from: 'projects/a.md', to: 'work/projects/a.md' },
      { from: 'projects/sub/b.md', to: 'work/projects/sub/b.md' },
    ])
    expect(remapUnder(docs, 'inbox.md', 'archive/inbox.md')).toEqual([
      { from: 'inbox.md', to: 'archive/inbox.md' },
    ])
  })
})

describe('tree-paths: a file dropped from the OS', () => {
  const WIN_ROOT = 'C:\\Users\\ada\\Holi\\o\\r'

  it('names a file by its last segment, whichever separator the OS uses', () => {
    expect(sourceName('C:\\Users\\ada\\Downloads\\a b.png')).toBe('a b.png')
    expect(sourceName('C:/Users/ada/Downloads/a.png')).toBe('a.png')
    expect(sourceName('\\\\server\\share\\a.pdf')).toBe('a.pdf')
    expect(sourceName('/Users/ada/Downloads/a.png')).toBe('a.png')
    // A POSIX name may hold a backslash.
    expect(sourceName('/Users/ada/a\\b.png')).toBe('a\\b.png')
  })

  it('finds the vault path of a file already in the vault', () => {
    expect(sourceInside(WIN_ROOT, `${WIN_ROOT}\\notes\\a.md`)).toBe('notes/a.md')
    expect(sourceInside(WIN_ROOT, 'c:\\users\\ada\\holi\\o\\r\\a.md')).toBe('a.md')
    expect(sourceInside(WIN_ROOT, 'C:/Users/ada/Holi/o/r/notes/a.md')).toBe('notes/a.md')
    expect(sourceInside(`${WIN_ROOT}\\`, `${WIN_ROOT}\\a.md`)).toBe('a.md')
  })

  it('leaves what is outside the vault outside', () => {
    expect(sourceInside(WIN_ROOT, 'C:\\Users\\ada\\Holi\\o\\r-other\\a.md')).toBeNull()
    expect(sourceInside(WIN_ROOT, 'C:\\Users\\ada\\Downloads\\a.md')).toBeNull()
    expect(sourceInside(WIN_ROOT, WIN_ROOT)).toBeNull()
  })

  it('reads POSIX paths as before', () => {
    const root = '/Users/ada/Holi/o/r'
    expect(sourceInside(root, `${root}/notes/a.md`)).toBe('notes/a.md')
    expect(sourceInside(root, `${root}-other/a.md`)).toBeNull()
    expect(sourceInside(root, '/users/ada/holi/o/r/a.md')).toBeNull()
    expect(sourceInside(`${root}/`, `${root}/a.md`)).toBe('a.md')
  })
})

describe('sourceInside with the vault’s own spellings', () => {
  const root = String.raw`C:\Users\ada\Holi\r`
  const index = vaultPathIndex(['Notes/Plan.md', 'Notes', 'Empty'], 'win32')

  it('answers a case-variant drop in the spelling the vault has, a folder too', () => {
    expect(sourceInside(root, String.raw`c:\users\ada\holi\r\NOTES\plan.MD`, index)).toBe(
      'Notes/Plan.md',
    )
    expect(sourceInside(root, String.raw`C:\Users\ada\Holi\r\empty`, index)).toBe('Empty')
  })

  it('keeps the source’s spelling for what the vault does not have yet', () => {
    expect(sourceInside(root, String.raw`C:\Users\ada\Holi\r\New.md`, index)).toBe('New.md')
  })

  it('plans the moves of a case-variant drop', () => {
    const docs = ['Notes/Plan.md', 'Notes/Todo.md']
    const rel = sourceInside(root, String.raw`c:\users\ada\holi\r\notes`, index)!
    expect(planMoveInto(docs, [rel], 'Archive')).toEqual([
      { from: 'Notes/Plan.md', to: 'Archive/Notes/Plan.md' },
      { from: 'Notes/Todo.md', to: 'Archive/Notes/Todo.md' },
    ])
  })
})
