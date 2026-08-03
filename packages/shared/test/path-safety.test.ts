import { describe, expect, it } from 'vitest'
import {
  GITKEEP,
  LOCAL_ONLY_IGNORE_LINES,
  PathSafetyError,
  isHiddenPath,
  isKeepFile,
  isLocalOnlyPath,
  vaultRelPath,
} from '../src/path-safety'

describe('isHiddenPath (explorer show/hide)', () => {
  it('hides a dot-prefixed file or dir at the root', () => {
    expect(isHiddenPath('.gitignore')).toBe(true)
    expect(isHiddenPath('.holi/vault.json')).toBe(true)
    expect(isHiddenPath('.claude/settings.json')).toBe(true)
  })

  it('hides a dot-prefixed segment at any depth', () => {
    expect(isHiddenPath('projects/.secret/notes.md')).toBe(true)
    expect(isHiddenPath('a/b/.foo')).toBe(true)
  })

  it('does not hide ordinary content', () => {
    expect(isHiddenPath('notes/plan.md')).toBe(false)
    expect(isHiddenPath('projects/q2/roadmap.md')).toBe(false)
  })

  it('always surfaces the managed markdown files (they are not dot-prefixed)', () => {
    for (const p of ['AGENTS.md', 'CLAUDE.md', 'MEMORY.md']) {
      expect(isHiddenPath(p)).toBe(false)
    }
  })
})

describe('isKeepFile (folder marker)', () => {
  it('matches a .gitkeep by basename at any depth', () => {
    expect(isKeepFile(GITKEEP)).toBe(true)
    expect(isKeepFile('bolig/.gitkeep')).toBe(true)
    expect(isKeepFile('a/b/c/.gitkeep')).toBe(true)
  })

  it('does not match ordinary files (including other dotfiles)', () => {
    expect(isKeepFile('bolig/note.md')).toBe(false)
    expect(isKeepFile('.gitignore')).toBe(false)
    expect(isKeepFile('.gitkeep.md')).toBe(false)
  })
})

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

describe('LOCAL_ONLY_IGNORE_LINES', () => {
  /** A minimal gitignore matcher, covering only the forms this constant uses.
   *  Enough to prove the lines and the predicate agree. */
  const ignoredBy = (lines: readonly string[], path: string) =>
    lines.some((line) => {
      const base = path.split('/').at(-1)!
      if (!line.includes('*')) return path === line || base === line
      const re = new RegExp(`^${line.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      return re.test(base)
    })

  it('ignores exactly what isLocalOnlyPath refuses to treat as vault content', () => {
    // These two must not drift. `commitAll` runs `git add -A` and git knows
    // nothing about isLocalOnlyPath, so a line missing here publishes a
    // machine-local file to every collaborator.
    for (const path of [
      'USER.local.md',
      '.holi/settings.local.json',
      '.holi/context.local.json',
      '.holi/theme.local.json',
      'CLAUDE.local.md',
    ]) {
      expect(isLocalOnlyPath(path)).toBe(true)
      expect(ignoredBy(LOCAL_ONLY_IGNORE_LINES, path)).toBe(true)
    }
  })

  it('does not ignore ordinary vault content — incl. a bare USER.md (local-ness is only the .local. marker)', () => {
    // USER.md is no longer special-cased: a synced-looking name IS synced. The
    // personal model lives at USER.local.md, whose name declares its locality.
    for (const path of ['AGENTS.md', 'MEMORY.md', 'USER.md', 'notes/user.md', 'projects/local-plans.md']) {
      expect(isLocalOnlyPath(path)).toBe(false)
      expect(ignoredBy(LOCAL_ONLY_IGNORE_LINES, path)).toBe(false)
    }
  })
})
