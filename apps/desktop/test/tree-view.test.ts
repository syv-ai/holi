import { describe, expect, it } from 'vitest'
import { isAppBundlePath } from '@holi/shared'
import { folderClaims, folderDocumentAt } from '../src/renderer/src/lib/folder-documents'
import { buildTreeData } from '../src/renderer/src/lib/tree-data'

import {
  canMoveInto,
  dropFolder,
  newItemPlace,
  rangeBetween,
  typeahead,
  visibleRows,
} from '../src/renderer/src/lib/tree-view'

const apps = folderClaims([
  { match: isAppBundlePath, folder: { surface: 'app', entry: 'index.html' } },
])
const isDocument = (dir: string, has: (path: string) => boolean) =>
  folderDocumentAt(apps, dir, has) !== null

const data = buildTreeData(['a/x.md', 'a/y.md', 'a/b/z.md', 'root.md'])
const ids = (open: string[]) => visibleRows(data, new Set(open)).map((r) => r.id)

describe('visibleRows', () => {
  it('lists folders first, and only the contents of open folders', () => {
    expect(ids([])).toEqual(['a', 'root.md'])
    expect(ids(['a'])).toEqual(['a', 'a/b', 'a/x.md', 'a/y.md', 'root.md'])
    expect(ids(['a', 'a/b'])).toEqual(['a', 'a/b', 'a/b/z.md', 'a/x.md', 'a/y.md', 'root.md'])
  })

  it("shows an app's files only once it is expanded, like a folder's", () => {
    const withApp = buildTreeData(['Budget.app/index.html', 'Budget.app/app.yaml'], [], isDocument)
    const rows = (open: string[]) => visibleRows(withApp, new Set(open)).map((r) => r.id)
    expect(rows([])).toEqual(['Budget.app'])
    expect(rows(['Budget.app'])).toEqual([
      'Budget.app',
      'Budget.app/app.yaml',
      'Budget.app/index.html',
    ])
  })

  it('hides an open folder whose parent is closed', () => {
    expect(ids(['a/b'])).toEqual(['a', 'root.md'])
  })
})

describe('rangeBetween', () => {
  const rows = visibleRows(data, new Set(['a']))
  it('spans the two rows in either direction', () => {
    expect(rangeBetween(rows, 'a/b', 'a/y.md')).toEqual(['a/b', 'a/x.md', 'a/y.md'])
    expect(rangeBetween(rows, 'a/y.md', 'a/b')).toEqual(['a/b', 'a/x.md', 'a/y.md'])
  })
  it('is just the target when the anchor is no longer visible', () => {
    expect(rangeBetween(rows, 'a/b/z.md', 'a/x.md')).toEqual(['a/x.md'])
  })
})

describe('typeahead', () => {
  const rows = visibleRows(data, new Set(['a']))
  const label = (id: string) => id.slice(id.lastIndexOf('/') + 1)
  it('finds the next row after the focused one, wrapping, ignoring case', () => {
    expect(typeahead(rows, 'a/x.md', 'Y', label)).toBe('a/y.md')
    expect(typeahead(rows, 'root.md', 'a', label)).toBe('a')
  })
  it('stays on the focused row while a longer query still matches it', () => {
    expect(typeahead(rows, 'root.md', 'ro', label)).toBe('root.md')
  })
  it('finds nothing for a query no row starts with', () => {
    expect(typeahead(rows, 'a', 'q', label)).toBeUndefined()
  })
})

describe('canMoveInto', () => {
  it('refuses a no-op and a folder into itself or below itself', () => {
    expect(canMoveInto(['a/x.md'], 'a')).toBe(false)
    expect(canMoveInto(['a'], 'a')).toBe(false)
    expect(canMoveInto(['a'], 'a/b')).toBe(false)
  })
  it('allows a real move, and a sibling that only shares a prefix', () => {
    expect(canMoveInto(['a/x.md'], 'a/b')).toBe(true)
    expect(canMoveInto(['a/x.md'], '')).toBe(true)
    expect(canMoveInto(['a'], 'ab')).toBe(true)
  })
})

describe('dropFolder', () => {
  it('is the folder dropped on, a file’s folder, or the root', () => {
    expect(dropFolder('a/b', true)).toBe('a/b')
    expect(dropFolder('a/x.md', false)).toBe('a')
    expect(dropFolder('root.md', false)).toBe('')
    expect(dropFolder(null, false)).toBe('')
  })
})

describe('newItemPlace', () => {
  const withApp = buildTreeData(
    ['a/x.md', 'a/b/z.md', 'root.md', 'a/Budget.app/index.html'],
    [],
    isDocument,
  )
  it('is the root, first, with nothing focused or a focus that is gone', () => {
    expect(newItemPlace(null, withApp)).toEqual({ parent: '', after: null })
    expect(newItemPlace('gone.md', withApp)).toEqual({ parent: '', after: null })
  })
  it('is inside a focused folder, first', () => {
    expect(newItemPlace('a/b', withApp)).toEqual({ parent: 'a/b', after: null })
  })
  it('is right after a focused file, in its folder', () => {
    expect(newItemPlace('a/x.md', withApp)).toEqual({ parent: 'a', after: 'a/x.md' })
    expect(newItemPlace('root.md', withApp)).toEqual({ parent: '', after: 'root.md' })
  })
  it('is beside a focused app, which is a file to the tree', () => {
    expect(newItemPlace('a/Budget.app', withApp)).toEqual({ parent: 'a', after: 'a/Budget.app' })
  })
})
