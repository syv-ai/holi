import { describe, expect, it } from 'vitest'
import {
  AGENT_CONFIG_FILES,
  AGENT_SURFACE_FILES,
  APPS_DIR,
  appIdFromPath,
  isAppRootPath,
  GITKEEP,
  LOCAL_ONLY_IGNORE_LINES,
  PathSafetyError,
  VAULT_CONFIG_FILES,
  isAgentSurfacePath,
  isHiddenPath,
  isKeepFile,
  isLocalOnlyPath,
  isValidAppId,
  isVaultConfigPath,
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

describe('isVaultConfigPath (config-conflict prominence)', () => {
  it('matches exactly the shared, committed config files', () => {
    // A conflict in these can leave the vault misconfigured while it lasts —
    // vaults-sync.md Edge cases singles them out as worth showing prominently.
    for (const p of VAULT_CONFIG_FILES) {
      expect(isVaultConfigPath(p)).toBe(true)
    }
    expect(isVaultConfigPath('.holi/settings.json')).toBe(true)
    expect(isVaultConfigPath('.claude/settings.json')).toBe(true)
  })

  it('does not match machine-local overrides (they never sync, so never conflict)', () => {
    expect(isVaultConfigPath('.holi/settings.local.json')).toBe(false)
  })

  it('does not match other files in the config dirs, or ordinary content', () => {
    for (const p of [
      '.holi/theme.json',
      '.holi/vault.json',
      '.claude/agents/foo.md',
      'settings.json',
      'notes/settings.json',
      'projects/plan.md',
    ]) {
      expect(isVaultConfigPath(p)).toBe(false)
    }
  })
})

describe('AGENT_CONFIG_FILES (restart-to-pick-up detection)', () => {
  it('is the launch-loaded agent config: settings + memory, not Holi config or local overrides', () => {
    expect(AGENT_CONFIG_FILES).toContain('.claude/settings.json')
    expect(AGENT_CONFIG_FILES).toContain('CLAUDE.md')
    expect(AGENT_CONFIG_FILES).toContain('AGENTS.md')
    // Holi's own config never affects the agent; local overrides never sync.
    expect(AGENT_CONFIG_FILES).not.toContain('.holi/settings.json')
    expect(AGENT_CONFIG_FILES).not.toContain('.claude/settings.local.json')
  })

  it('shares .claude/settings.json with VAULT_CONFIG_FILES — both conflict-worthy and restart-worthy', () => {
    expect(VAULT_CONFIG_FILES).toContain('.claude/settings.json')
    expect(AGENT_CONFIG_FILES).toContain('.claude/settings.json')
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

describe('isAgentSurfacePath (what a vault app may never touch)', () => {
  it('matches the four managed instruction files', () => {
    for (const path of AGENT_SURFACE_FILES) {
      expect(isAgentSurfacePath(path)).toBe(true)
    }
    expect([...AGENT_SURFACE_FILES]).toEqual(['AGENTS.md', 'CLAUDE.md', 'MEMORY.md', 'USER.local.md'])
  })

  it('matches everything under .claude/ — settings, hooks and skills alike', () => {
    // `.claude/hooks/google-send-gate.mjs` IS the mail send gate, so a readable
    // or writable agent surface is an app escalating to the agent.
    expect(isAgentSurfacePath('.claude/settings.json')).toBe(true)
    expect(isAgentSurfacePath('.claude/hooks/google-send-gate.mjs')).toBe(true)
    expect(isAgentSurfacePath('.claude/skills/theme/SKILL.md')).toBe(true)
  })

  it('matches everything under memory/ — MEMORY.md subdivided is still memory', () => {
    // D89. A vault app hosts untrusted code, and what the user told the
    // assistant does not become readable by spreading it over more files.
    expect(isAgentSurfacePath('memory/shell-quirks.md')).toBe(true)
    expect(isAgentSurfacePath('memory/people/ada.md')).toBe(true)
    expect(isAgentSurfacePath('memory/index.md')).toBe(true)
    // A personal one is refused for a second reason on top of this one.
    expect(isAgentSurfacePath('memory/salary.local.md')).toBe(true)
  })

  it('is an exact match at the root, so a same-named note elsewhere is ordinary content', () => {
    // The same rule isVaultConfigPath follows: `notes/AGENTS.md` is a note a
    // human wrote about agents, not the file the agent loads.
    expect(isAgentSurfacePath('notes/AGENTS.md')).toBe(false)
    expect(isAgentSurfacePath('agents.md')).toBe(false)
    expect(isAgentSurfacePath('inbox.md')).toBe(false)
    // `memory/` is a PREFIX, so the same courtesy applies one level down.
    expect(isAgentSurfacePath('notes/memory/x.md')).toBe(false)
    expect(isAgentSurfacePath('memory.md')).toBe(false)
  })

  it('leaves the rest of .holi/ alone — that is Holi config, not the agent surface', () => {
    expect(isAgentSurfacePath('.holi/settings.json')).toBe(false)
    expect(isAgentSurfacePath('.holi/theme.json')).toBe(false)
    expect(isAgentSurfacePath('.holi/apps/retro/index.html')).toBe(false)
  })

  it('leaves git hooks out — they are not vault content', () => {
    // Holi's pre-commit lives in `.git/hooks/`, which is never committed and
    // never listed by the vault store, so an app cannot reach it at all. The
    // rule would be needed for a hook seeded into the tracked tree, which is
    // one of the reasons there isn't one.
    expect(isAgentSurfacePath('.holi/git-hooks/pre-commit')).toBe(false)
  })
})

describe('isValidAppId', () => {
  it('accepts a lowercase, dash-separated name', () => {
    expect(isValidAppId('retro-board')).toBe(true)
    expect(isValidAppId('csv2')).toBe(true)
    expect(isValidAppId('a')).toBe(true)
  })

  it('rejects anything that would not survive being a URL host', () => {
    // The id becomes the HOST of a `holi-app://` URL, and hosts are case-folded:
    // `My_App` and `my_app` would collide, and a mixed-case directory would 404
    // in a way that reads as a path bug. So the grammar is restricted instead.
    for (const id of ['My_App', 'retro_board', 'retro board', 'Retro', '', '..', 'a/b']) {
      expect(isValidAppId(id)).toBe(false)
    }
  })
})

describe('appIdFromPath', () => {
  it('reads the id out of any path inside the app directory', () => {
    expect(appIdFromPath('.holi/apps/retro/index.html')).toBe('retro')
    expect(appIdFromPath('.holi/apps/retro/sub/app.js')).toBe('retro')
    expect(appIdFromPath('.holi/apps/retro')).toBe('retro')
  })

  it('is null for an invalid id or a path outside APPS_DIR', () => {
    expect(appIdFromPath('.holi/apps/My_App/index.html')).toBe(null)
    expect(appIdFromPath('.holi/theme.json')).toBe(null)
    expect(appIdFromPath('notes/x.md')).toBe(null)
    expect(appIdFromPath('.holi/appsy/retro/index.html')).toBe(null)
    expect(appIdFromPath(APPS_DIR)).toBe(null)
  })
})

describe('isAppRootPath', () => {
  it('is true for the app folder itself', () => {
    expect(isAppRootPath('.holi/apps/retro')).toBe(true)
  })

  it('is false for everything inside it — the app is the folder, not its files', () => {
    // The distinction from `appIdFromPath`, which answers "which app is this
    // part of" and is happy with all three of these.
    expect(isAppRootPath('.holi/apps/retro/index.html')).toBe(false)
    expect(isAppRootPath('.holi/apps/retro/sub')).toBe(false)
    expect(isAppRootPath('.holi/apps/retro/sub/app.js')).toBe(false)
  })

  it('is false for the apps directory itself and for anything outside it', () => {
    expect(isAppRootPath(APPS_DIR)).toBe(false)
    expect(isAppRootPath('.holi/apps/My_App')).toBe(false)
    expect(isAppRootPath('notes/retro')).toBe(false)
  })
})
