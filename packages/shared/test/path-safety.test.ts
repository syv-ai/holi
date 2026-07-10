import { describe, expect, it } from 'vitest'
import { PathSafetyError, vaultRelPath } from '../src/path-safety'

describe('vaultRelPath (pure lexical validation)', () => {
  it('accepts a plain relative path and returns it unchanged', () => {
    expect(vaultRelPath('projects/q2/roadmap.md')).toBe('projects/q2/roadmap.md')
  })

  it('rejects `..` traversal anywhere in the path', () => {
    expect(() => vaultRelPath('../etc/passwd')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('a/../b')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('a/b/..')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('..')).toThrow(PathSafetyError)
  })

  it('rejects absolute paths in every flavor (POSIX, drive letter, UNC) and backslashes', () => {
    expect(() => vaultRelPath('/etc/passwd')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('C:/windows/system32')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('C:\\windows')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('\\\\server\\share')).toThrow(PathSafetyError)
    // Backslash is rejected outright: on Windows it is a separator (so `a\\..\\b`
    // would smuggle traversal past `/`-based checks), and in vault paths the
    // canonical separator is `/`.
    expect(() => vaultRelPath('notes\\draft.md')).toThrow(PathSafetyError)
  })

  it('rejects empty paths and NUL bytes', () => {
    expect(() => vaultRelPath('')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('a/b\0.md')).toThrow(PathSafetyError)
  })

  it('normalizes ./ segments, doubled slashes, and trailing slashes', () => {
    expect(vaultRelPath('./a/b.md')).toBe('a/b.md')
    expect(vaultRelPath('a//b.md')).toBe('a/b.md')
    expect(vaultRelPath('a/b/')).toBe('a/b')
    expect(vaultRelPath('a/./b.md')).toBe('a/b.md')
  })

  it('rejects paths that normalize to nothing', () => {
    expect(() => vaultRelPath('.')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('./')).toThrow(PathSafetyError)
    expect(() => vaultRelPath('//')).toThrow(PathSafetyError)
  })

  it('keeps dotfiles and unicode names legal', () => {
    expect(vaultRelPath('.claude/settings.json')).toBe('.claude/settings.json')
    expect(vaultRelPath('AGENTS.md')).toBe('AGENTS.md')
    expect(vaultRelPath('nøter/æøå.md')).toBe('nøter/æøå.md')
  })
})
