import { describe, expect, it } from 'vitest'
import {
  basename,
  expandToFiles,
  freeCopyPath,
  joinPath,
  parentOf,
  pathTaken,
  remapUnder,
  renameBasenameRange,
  withMdExtension,
} from '../src/renderer/src/lib/tree-paths'

describe('tree-paths', () => {
  it('joins, tolerating empty parent', () => {
    expect(joinPath('', 'a.md')).toBe('a.md')
    expect(joinPath('projects', 'a.md')).toBe('projects/a.md')
  })
  it('ensures a .md note name — the vault is markdown-only, so a foreign extension would vanish', () => {
    expect(withMdExtension('note')).toBe('note.md')
    expect(withMdExtension('note.md')).toBe('note.md')
    // A non-.md name would be written but dropped by the md-only scanner (an
    // invisible file that then collides on retry) — so append, Obsidian-style.
    expect(withMdExtension('hello.json')).toBe('hello.json.md')
    expect(withMdExtension('a.canvas')).toBe('a.canvas.md')
  })
  it('basename and parentOf', () => {
    expect(basename('projects/a.md')).toBe('a.md')
    expect(parentOf('projects/sub/a.md')).toBe('projects/sub')
    expect(parentOf('a.md')).toBe('')
  })
  it('renameBasenameRange selects the name without the extension', () => {
    // used to pre-select the editable portion on rename (VS Code behavior)
    expect(renameBasenameRange('roadmap.md')).toEqual([0, 7])
    expect(renameBasenameRange('no-ext')).toEqual([0, 6])
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

  it('pathTaken sees a file OR a folder-prefix collision', () => {
    expect(pathTaken(docs, 'inbox.md')).toBe(true)
    expect(pathTaken(docs, 'projects')).toBe(true) // occupied as a folder prefix
    expect(pathTaken(docs, 'nope')).toBe(false)
  })

  it('freeCopyPath appends " copy", then " copy 2", before the extension', () => {
    const taken = (p: string) => pathTaken(['a.md', 'a copy.md'], p)
    expect(freeCopyPath(taken, 'fresh.md')).toBe('fresh.md') // free — untouched
    expect(freeCopyPath(taken, 'a.md')).toBe('a copy 2.md') // a.md and a copy.md taken
    expect(freeCopyPath((p) => pathTaken(['a.md'], p), 'a.md')).toBe('a copy.md')
  })

  it('freeCopyPath suffixes a folder name (no extension)', () => {
    const taken = (p: string) => pathTaken(['projects/x.md'], p)
    expect(freeCopyPath(taken, 'projects')).toBe('projects copy')
  })
})
