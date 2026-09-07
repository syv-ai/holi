import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
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
  it('appends .md only when NO extension is present — a typed extension is kept literally', () => {
    expect(withMdExtension('note')).toBe('note.md')
    expect(withMdExtension('note.md')).toBe('note.md')
    // A typed extension is a real file of that type now (the vault holds any
    // file), so it is kept literally rather than coerced to markdown.
    expect(withMdExtension('hello.json')).toBe('hello.json')
    expect(withMdExtension('data.csv')).toBe('data.csv')
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

describe('ancestorsOf — the branch a reveal has to expand (#18)', () => {
  it('lists every folder between the root and the file, outermost first', () => {
    // Order is load-bearing: a child cannot be expanded before its parent has
    // been, so the reveal walks this list downwards.
    expect(ancestorsOf('.holi/apps/tasks-by-area/index.html')).toEqual([
      '.holi',
      '.holi/apps',
      '.holi/apps/tasks-by-area',
    ])
  })

  it('is empty at the top level, where there is nothing to expand', () => {
    expect(ancestorsOf('AGENTS.md')).toEqual([])
  })

  it('excludes the path itself — it is the target, not a folder on the way', () => {
    expect(ancestorsOf('a/b')).toEqual(['a'])
  })
})
