import { describe, expect, it } from 'vitest'
import {
  CORE_TRANSFORMS,
  checkPluginCatalogue,
  resolvePlugins,
  parseSettingsPatch,
  parseSettingsText,
  resolveVaultSettings,
  writeSettingsText,
  type PluginInfo,
} from '../src/index'

// Test-only plugins: one on by default, one off.
const KNOWN: PluginInfo[] = [
  { id: 'reader', label: 'Reader', default: true },
  { id: 'extra', label: 'Extra', default: false },
]

const enabled = (committed: string | null, local: string | null) =>
  [...resolvePlugins(resolveVaultSettings(committed, local).plugins, KNOWN).running].sort()

describe('resolvePlugins', () => {
  it('runs each plugin by its default when the vault says nothing', () => {
    expect(enabled(null, null)).toEqual(KNOWN.filter((p) => p.default).map((p) => p.id))
  })

  it('leaves a plugin off wherever one it requires is, down a chain, and says why', () => {
    const chain: PluginInfo[] = [
      { id: 'base', label: 'Base', default: true },
      { id: 'face', label: 'Face', default: true, requires: ['base'] },
      { id: 'skin', label: 'Skin', default: true, requires: ['face'] },
    ]
    const run = (committed: string | null, local: string | null = null) => {
      const r = resolvePlugins(resolveVaultSettings(committed, local).plugins, chain)
      return { running: [...r.running].sort(), status: Object.fromEntries(r.status) }
    }
    expect(run(null).running).toEqual(['base', 'face', 'skin'])
    expect(run('plugins:\n  face: false\n').running).toEqual(['base'])
    expect(run(null, 'plugins:\n  base: false\n').status).toEqual({
      base: { kind: 'off-here' },
      face: { kind: 'needs', missing: ['base'] },
      skin: { kind: 'needs', missing: ['face'] },
    })
    expect(run('plugins:\n  base: false\n').status.base).toEqual({ kind: 'off-vault' })
  })

  it('refuses a catalogue that could never work', () => {
    const p = (id: string, requires?: string[]): PluginInfo => ({
      id,
      label: id,
      default: true,
      requires,
    })
    expect(() => checkPluginCatalogue([p('a'), p('a')])).toThrow('twice')
    expect(() => checkPluginCatalogue([p('a', ['gone'])])).toThrow('requires gone')
    expect(() => checkPluginCatalogue([p('a', ['b']), p('b', ['a'])])).toThrow('each other')
    expect(() => checkPluginCatalogue([p('a'), p('b', ['a'])])).not.toThrow()
  })

  it("takes the vault's answer over the default", () => {
    expect(enabled('plugins:\n  reader: false\n  extra: true\n', null)).toEqual(['extra'])
  })

  it('lets this machine turn a plugin off, never on', () => {
    const local = 'plugins:\n  reader: false\n  extra: true\n'
    const resolved = resolveVaultSettings(null, local)
    expect(resolved.plugins.localOff).toEqual(['reader'])
    expect(resolved.warnings.some((w) => w.includes('"plugins.extra"'))).toBe(true)
    expect(enabled(null, local)).toEqual([])
  })

  it('keeps an id this build does not have, and ignores it', () => {
    const resolved = resolveVaultSettings('plugins:\n  someday: true\n', null)
    expect(resolved.plugins.vault).toEqual({ someday: true })
    expect(resolved.warnings).toEqual([])
  })

  it('refuses what is not a plugin id or a boolean, in a read and a write', () => {
    const text = 'plugins:\n  Bad_Id: true\n  reader: yes please\n'
    expect(resolveVaultSettings(text, null).plugins.vault).toEqual({})
    expect(parseSettingsPatch(text, CORE_TRANSFORMS).patch).toEqual({})
    expect(parseSettingsPatch('plugins:\n  reader: false\n', CORE_TRANSFORMS).patch).toEqual({
      plugins: { reader: false },
    })
  })
})

describe('the plugins block in a settings file', () => {
  it('lists every known plugin in the committed file, an unanswered one commented', () => {
    const written = writeSettingsText({ plugins: { extra: true } }, 'committed', KNOWN)
    expect(written).toMatch(/^plugins:$/m)
    expect(written).toContain('  # reader: true')
    expect(parseSettingsText(written).plugins).toEqual({ extra: true })
  })

  it('comments the whole block when nothing is answered', () => {
    const written = writeSettingsText({}, 'committed', KNOWN)
    expect(written).toContain('# plugins:')
    expect(parseSettingsText(written).plugins).toBeUndefined()
  })

  it('shows it in the local file only when that file answers', () => {
    expect(writeSettingsText({}, 'local', KNOWN)).not.toContain('plugins')
    const written = writeSettingsText({ plugins: { reader: false } }, 'local', KNOWN)
    expect(parseSettingsText(written).plugins).toEqual({ reader: false })
  })
})
