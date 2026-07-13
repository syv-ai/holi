import { describe, expect, it } from 'vitest'
import { parseGithubRepoUrl, sshRemote } from '../src/git/repo-url'

describe('parseGithubRepoUrl', () => {
  it.each([
    ['https://github.com/syv-ai/vault-x', 'syv-ai', 'vault-x'],
    ['https://github.com/syv-ai/vault-x.git', 'syv-ai', 'vault-x'],
    ['https://github.com/syv-ai/vault-x/', 'syv-ai', 'vault-x'],
    ['git@github.com:syv-ai/vault-x.git', 'syv-ai', 'vault-x'],
    ['git@github.com:syv-ai/vault-x', 'syv-ai', 'vault-x'],
  ])('parses %s', (raw, owner, repo) => {
    expect(parseGithubRepoUrl(raw)).toEqual({ owner, repo })
  })

  it.each([
    'https://gitlab.com/a/b',
    'https://github.com/only-owner',
    'https://github.com/a/b/c',
    'ftp://github.com/a/b',
    'not a url',
    'git@github.com:a',
  ])('rejects %s', (raw) => {
    expect(() => parseGithubRepoUrl(raw)).toThrow(/github/i)
  })
})

describe('sshRemote', () => {
  it('builds the ssh form', () => {
    expect(sshRemote({ owner: 'syv-ai', repo: 'vault-x' })).toBe('git@github.com:syv-ai/vault-x.git')
  })
})
