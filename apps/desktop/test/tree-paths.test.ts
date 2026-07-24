import { describe, expect, it } from 'vitest'
import {
  basename,
  joinPath,
  parentOf,
  renameBasenameRange,
  withMdExtension,
} from '../src/renderer/src/lib/tree-paths'

describe('tree-paths', () => {
  it('joins, tolerating empty parent', () => {
    expect(joinPath('', 'a.md')).toBe('a.md')
    expect(joinPath('projects', 'a.md')).toBe('projects/a.md')
  })
  it('appends .md only when no extension is present', () => {
    expect(withMdExtension('note')).toBe('note.md')
    expect(withMdExtension('note.md')).toBe('note.md')
    expect(withMdExtension('a.canvas')).toBe('a.canvas')
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
