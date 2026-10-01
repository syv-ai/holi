import { describe, expect, it } from 'vitest'
import {
  enabledPlugins,
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
  [...enabledPlugins(resolveVaultSettings(committed, local).plugins, KNOWN)].sort()

describe('enabledPlugins', () => {
  it('runs each plugin by its default when the vault says nothing', () => {
    expect(enabled(null, null)).toEqual(KNOWN.filter((p) => p.default).map((p) => p.id))
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
    expect(parseSettingsPatch(text).patch).toEqual({})
    expect(parseSettingsPatch('plugins:\n  reader: false\n').patch).toEqual({
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
