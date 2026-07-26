import { describe, expect, it } from 'vitest'
import { buildTreeData, ROOT_ID } from '../src/renderer/src/lib/tree-data'

describe('buildTreeData', () => {
  it('nests docs under folder ids and lists top-level under root', () => {
    const data = buildTreeData(['inbox.md', 'projects/roadmap.md', 'projects/ideas.md'])
    expect(data[ROOT_ID].children).toEqual(['projects', 'inbox.md']) // folders first, then alpha
    expect(data['projects'].isFolder).toBe(true)
    expect(data['projects'].children).toEqual(['projects/ideas.md', 'projects/roadmap.md'])
    expect(data['projects/roadmap.md'].isFolder).toBe(false)
    expect(data['inbox.md'].name).toBe('inbox.md')
  })

  it('does not filter hidden entries — that is the tree view\'s job now (isHiddenPath)', () => {
    // buildTreeData is a pure projection of the paths it is given; FileTree filters
    // dotfiles upstream via the per-vault show/hide toggle. MEMORY.md is never
    // hidden (not dot-prefixed), so it stays regardless.
    const data = buildTreeData(['.holi/vault.json', 'MEMORY.md', 'note.md'])
    expect(data[ROOT_ID].children).toEqual(['.holi', 'MEMORY.md', 'note.md'])
  })

  it('includes an empty pending folder that has no docs', () => {
    const data = buildTreeData(['note.md'], ['drafts'])
    expect(data[ROOT_ID].children).toEqual(['drafts', 'note.md'])
    expect(data['drafts']).toEqual({ name: 'drafts', isFolder: true, children: [] })
  })

  it('does not duplicate a folder that is both pending and has a doc', () => {
    const data = buildTreeData(['drafts/x.md'], ['drafts'])
    expect(data['drafts'].children).toEqual(['drafts/x.md'])
    expect(data[ROOT_ID].children).toEqual(['drafts'])
  })
})
