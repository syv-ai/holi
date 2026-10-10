import { describe, expect, it } from 'vitest'
import {
  isCommunityPluginId,
  opensPath,
  parsePluginManifest,
  parsePluginPin,
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

  it('needs semver and a kebab-case id', () => {
    expect(problems({ ...prezzi, version: 'v1' })).toHaveLength(1)
    expect(problems({ ...prezzi, id: 'Prezzi' })).toHaveLength(1)
  })
})

describe('parsePluginPin', () => {
  const commit = 'a'.repeat(40)

  it('is the manifest plus where it came from', () => {
    expect(parsePluginPin({ ...prezzi, repo: 'syv-ai/prezzi', commit })).toEqual({
      ok: true,
      value: { ...prezzi, repo: 'syv-ai/prezzi', commit },
    })
  })

  it('needs a full commit and an owner/repo', () => {
    expect(parsePluginPin({ ...prezzi, repo: 'syv-ai/prezzi', commit: 'abc123' }).ok).toBe(false)
    expect(parsePluginPin({ ...prezzi, repo: 'https://github.com/syv-ai/prezzi', commit }).ok).toBe(
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
