import { describe, expect, it } from 'vitest'
import {
  isCommandName,
  isCommunityPluginId,
  opensPath,
  parsePluginManifest,
  parsePluginPin,
  parseReleaseTag,
  pluginManifestPath,
  releaseTag,
  pluginPinPath,
  servedFile,
} from '../src/community-plugin'

const prezzi = {
  id: 'prezzi',
  name: 'Prezzi',
  version: '0.1.0',
  opens: ['slides.md'],
  setup: ['sh', 'scripts/holi-setup.sh'],
  serve: ['node', 'bin/holi-serve.mjs', '{file}', '--port', '{port}'],
  ignore: ['slides-export.pdf', '.slidev/'],
}

const problems = (json: unknown): string[] => {
  const parsed = parsePluginManifest(json)
  return parsed.ok ? [] : parsed.problems
}

describe('parsePluginManifest', () => {
  it('reads a Prezzi-shaped manifest', () => {
    expect(parsePluginManifest(prezzi)).toEqual({ ok: true, value: prezzi })
  })

  it('needs serve to pass {port}', () => {
    expect(problems({ ...prezzi, serve: ['node', 'serve.mjs'] })).toEqual([
      'serve must pass {port}',
    ])
  })

  it('refuses a shell string as a command', () => {
    expect(problems({ ...prezzi, setup: ['pnpm install && pnpm build'] })).toHaveLength(1)
  })

  it('refuses a placeholder Holi does not fill in', () => {
    expect(problems({ ...prezzi, serve: ['x', '{port}', '{home}'] })).toHaveLength(1)
  })

  it('takes file names and extensions in opens, not globs', () => {
    expect(problems({ ...prezzi, opens: ['slides.md', '*.deck'] })).toEqual([])
    expect(problems({ ...prezzi, opens: ['**/slides.md'] })).toHaveLength(1)
    expect(problems({ ...prezzi, opens: [] })).toHaveLength(1)
    expect(
      problems({ ...prezzi, opens: [], folder: { suffix: '.deck', entry: 'slides.md' } }),
    ).toEqual([])
    expect(problems({ ...prezzi, folder: { suffix: 'deck', entry: 'a/b.md' } })).toHaveLength(2)
  })

  it('takes skills as folders inside the plugin', () => {
    expect(
      problems({ ...prezzi, skills: ['holi/skills/prezzi', '.agents/skills/slidev'] }),
    ).toEqual([])
    expect(problems({ ...prezzi, skills: ['../elsewhere'] })).toHaveLength(1)
    expect(problems({ ...prezzi, skills: ['/etc'] })).toHaveLength(1)
  })

  it('ships apps without a server, and needs a server only to open something', () => {
    const notes = { id: 'notes', name: 'Notes', version: '1.0.0', apps: ['apps/Notes.app'] }
    expect(problems(notes)).toEqual([])
    expect(problems({ ...notes, apps: ['apps/notes'] })).toHaveLength(1)
    expect(problems({ ...notes, apps: undefined })).toHaveLength(1)
    expect(problems({ ...prezzi, serve: undefined })).toHaveLength(1)
  })

  it('ships commands for the agent, by name, as files inside the plugin', () => {
    const dash = { id: 'dash', name: 'Dash', version: '0.1.0', bin: { dashctl: 'bin/dashctl' } }
    expect(parsePluginManifest(dash)).toEqual({ ok: true, value: { ...dash, opens: [] } })
    expect(problems({ ...dash, bin: {} })).toHaveLength(1)
    expect(problems({ ...dash, bin: { dashctl: '../dashctl' } })).toHaveLength(1)
    expect(problems({ ...dash, bin: { dashctl: '/usr/bin/env' } })).toHaveLength(1)
    expect(problems({ ...dash, bin: { 'Dash Ctl': 'bin/x' } })).toHaveLength(1)
    expect(problems({ ...dash, bin: { holi: 'bin/holi' } })).toEqual([
      "bin: holi is Holi's own command",
    ])
    expect(problems({ ...dash, bin: ['bin/dashctl'] })).toHaveLength(1)
  })

  it('reads a readiness check: an argv like setup, and a one-line hint', () => {
    const dash = { id: 'dash', name: 'Dash', version: '0.1.0', bin: { dashctl: 'bin/dashctl' } }
    const check = { run: ['dashctl', 'version'], hint: 'Switch it on in Dash' }
    expect(parsePluginManifest({ ...dash, check })).toEqual({
      ok: true,
      value: { ...dash, opens: [], check },
    })
    expect(problems({ ...dash, check: ['dashctl', 'version'] })).toHaveLength(1)
    expect(problems({ ...dash, check: { ...check, run: ['dashctl version'] } })).toHaveLength(1)
    expect(problems({ ...dash, check: { ...check, run: ['x', '{home}'] } })).toHaveLength(1)
    expect(problems({ ...dash, check: { ...check, run: ['x', '{vault}'] } })).toEqual([])
    expect(problems({ ...dash, check: { ...check, run: ['x', '{file}'] } })).toHaveLength(1)
    expect(problems({ ...dash, check: { ...check, run: ['x', '--port', '{port}'] } })).toHaveLength(
      1,
    )
    expect(problems({ ...dash, check: { ...check, run: [] } })).toHaveLength(1)
    expect(problems({ ...dash, check: { run: check.run } })).toHaveLength(1)
    expect(problems({ ...dash, check: { ...check, hint: 'two\nlines' } })).toHaveLength(1)
    expect(problems({ ...dash, check: { ...check, hint: 'a\ttab' } })).toHaveLength(1)
    expect(problems({ ...dash, check: { ...check, hint: 'x'.repeat(201) } })).toHaveLength(1)
  })

  it('names a command without a path or shell meaning, and never holi', () => {
    for (const name of ['dashctl', 'gh2', 'my-tool', 'x.y_z'])
      expect(isCommandName(name)).toBe(true)
    for (const name of ['holi', 'a/b', '-x', 'Dash', 'a b', '$(x)', ''])
      expect(isCommandName(name)).toBe(false)
  })

  it('needs semver and a kebab-case id', () => {
    expect(problems({ ...prezzi, version: 'v1' })).toHaveLength(1)
    expect(problems({ ...prezzi, id: 'Prezzi' })).toHaveLength(1)
  })
})

describe('several plugins in one repository', () => {
  it('finds a plugin at the root or in the folder named after it', () => {
    expect(pluginManifestPath('')).toBe('holi-plugin.json')
    expect(pluginManifestPath('notes')).toBe('notes/holi-plugin.json')
    expect(parsePluginManifest(prezzi, 'prezzi').ok).toBe(true)
    expect(parsePluginManifest(prezzi, 'notes')).toEqual({
      ok: false,
      problems: ['a plugin in the folder notes/ must have the id notes'],
    })
  })

  it('gives each plugin its own release tags, and reads them back', () => {
    expect(releaseTag('', '0.1.0')).toBe('v0.1.0')
    expect(releaseTag('notes', '0.2.0')).toBe('notes-v0.2.0')
    expect(parseReleaseTag('v1.0.0-rc.1')).toEqual({ path: '', version: '1.0.0-rc.1' })
    expect(parseReleaseTag('tasks-extra-v0.2.0')).toEqual({ path: 'tasks-extra', version: '0.2.0' })
    for (const junk of ['1.0.0', 'notes-1.0.0', 'Notes-v1.0.0', 'v1.0', 'release-candidate'])
      expect(parseReleaseTag(junk)).toBeNull()
  })
})

describe('parsePluginPin', () => {
  const commit = 'a'.repeat(40)

  it('is the manifest plus where it came from', () => {
    expect(parsePluginPin({ ...prezzi, repo: 'syv-ai/prezzi', path: '', commit })).toEqual({
      ok: true,
      value: { ...prezzi, repo: 'syv-ai/prezzi', path: '', commit },
    })
  })

  it('names the folder it came from, which is its id', () => {
    const pin = { ...prezzi, repo: 'syv-ai/holi-plugins', commit }
    expect(parsePluginPin({ ...pin, path: 'prezzi' }).ok).toBe(true)
    expect(parsePluginPin({ ...pin, path: 'notes' }).ok).toBe(false)
    expect(parsePluginPin(pin).ok).toBe(false)
  })

  it('needs a full commit and an owner/repo', () => {
    const at = { ...prezzi, path: '' }
    expect(parsePluginPin({ ...at, repo: 'syv-ai/prezzi', commit: 'abc123' }).ok).toBe(false)
    expect(parsePluginPin({ ...at, repo: 'https://github.com/syv-ai/prezzi', commit }).ok).toBe(
      false,
    )
  })

  it('lives under .holi/plugins', () => {
    expect(pluginPinPath('prezzi')).toBe('.holi/plugins/prezzi/manifest.json')
  })
})

describe('servedFile', () => {
  const deck = { opens: [], folder: { suffix: '.deck', entry: 'slides.md' } }
  it("serves a folder's entry, by the folder's name", () => {
    expect(servedFile(deck, 'prezzis/q4.deck')).toBe('prezzis/q4.deck/slides.md')
    expect(servedFile(deck, 'prezzis/.deck')).toBeNull()
    expect(servedFile(deck, 'prezzis/q4.deck/slides.md')).toBeNull()
  })
  it('serves a file it opens as itself', () => {
    expect(servedFile(prezzi, 'decks/slides.md')).toBe('decks/slides.md')
  })
})

describe('isCommunityPluginId', () => {
  it('refuses a first-party id', () => {
    expect(isCommunityPluginId('prezzi', ['pdf', 'agent'])).toBe(true)
    expect(isCommunityPluginId('pdf', ['pdf', 'agent'])).toBe(false)
  })
})

describe('opensPath', () => {
  it('matches by the file name, anywhere in the vault', () => {
    expect(opensPath(prezzi, 'decks/q4/slides.md')).toBe(true)
    expect(opensPath(prezzi, 'slides.md')).toBe(true)
    expect(opensPath(prezzi, 'decks/slides.md.bak')).toBe(false)
    expect(opensPath(prezzi, 'slides.md/notes.md')).toBe(false)
  })

  it('matches an extension, but not the bare extension as a name', () => {
    expect(opensPath({ opens: ['*.deck'] }, 'a/talk.deck')).toBe(true)
    expect(opensPath({ opens: ['*.deck'] }, 'a/.deck')).toBe(false)
  })
})
