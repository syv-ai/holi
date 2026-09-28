/**
 * The facts the frontmatter header shows that are not in the file: its history
 * from git.
 */
import { describe, expect, it } from 'vitest'
import { fileHistory } from '../src/main/vault/file-facts'
import type { Commit } from '../src/main/git'

const commit = (date: string, author: string): Commit => ({
  sha: date,
  subject: 'autosave',
  date,
  author,
  added: 1,
  removed: 0,
})

describe('fileHistory', () => {
  it('reads last from the newest commit and created from the oldest', () => {
    // `git log` prints newest first; the far end is the file's creation.
    const history = fileHistory([
      commit('2026-09-25T10:00:00Z', 'ada-holm'),
      commit('2026-06-01T10:00:00Z', 'bo-lind'),
      commit('2026-03-02T10:00:00Z', 'cy-berg'),
    ])
    expect(history).toEqual({
      last: { date: '2026-09-25T10:00:00Z', author: 'ada-holm' },
      first: { date: '2026-03-02T10:00:00Z', author: 'cy-berg' },
      revisions: 3,
    })
  })

  it('is one commit that is both, for a file committed once', () => {
    const history = fileHistory([commit('2026-09-25T10:00:00Z', 'ada-holm')])
    expect(history?.first).toEqual(history?.last)
    expect(history?.revisions).toBe(1)
  })

  it('is null for a file with no commits yet', () => {
    expect(fileHistory([])).toBeNull()
  })
})
