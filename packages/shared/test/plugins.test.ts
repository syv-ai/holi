import { describe, expect, it } from 'vitest'
import {
  checkPluginCatalogue,
  resolvePlugins,
  parsePluginSettingsPatch,
  parseSettingsText,
  pluginSettingValue,
  resolvePluginSettings,
  writePluginSettingsText,
  type PluginInfo,
} from '../src/index'

// Test-only plugins: one on by default, one off.
const KNOWN: PluginInfo[] = [
  { id: 'reader', label: 'Reader', default: true },
  { id: 'extra', label: 'Extra', default: false },
]

const enabled = (committed: string | null, local: string | null) =>
  [...resolvePlugins(resolvePluginSettings(committed, local, KNOWN).plugins, KNOWN).running].sort()

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
      const r = resolvePlugins(resolvePluginSettings(committed, local, chain).plugins, chain)
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
    const resolved = resolvePluginSettings(null, local, KNOWN)
    expect(resolved.plugins.localOff).toEqual(['reader'])
    expect(resolved.warnings.some((w) => w.includes('"plugins.extra"'))).toBe(true)
    expect(enabled(null, local)).toEqual([])
  })

  it('keeps an id this build does not have, and ignores it', () => {
    const resolved = resolvePluginSettings('plugins:\n  someday: true\n', null, KNOWN)
    expect(resolved.plugins.vault).toEqual({ someday: true })
    expect(resolved.warnings).toEqual([])
  })

  it('refuses what is not a plugin id or a boolean, in a read and a write', () => {
    const text = 'plugins:\n  Bad_Id: true\n  reader: yes please\n'
    expect(resolvePluginSettings(text, null, KNOWN).plugins.vault).toEqual({})
    expect(parsePluginSettingsPatch(text, KNOWN).patch).toEqual({})
    expect(parsePluginSettingsPatch('plugins:\n  reader: false\n', KNOWN).patch).toEqual({
      plugins: { reader: false },
    })
  })
})

describe('the plugins block in the plugins file', () => {
  it('lists every known plugin in the committed file, an unanswered one commented', () => {
    const written = writePluginSettingsText({ plugins: { extra: true } }, 'committed', KNOWN)
    expect(written).toMatch(/^plugins:$/m)
    expect(written).toContain('  # reader: true')
    expect(parseSettingsText(written).plugins).toEqual({ extra: true })
  })

  it('comments the whole block when nothing is answered', () => {
    const written = writePluginSettingsText({}, 'committed', KNOWN)
    expect(written).toContain('# plugins:')
    expect(parseSettingsText(written).plugins).toBeUndefined()
  })

  it('shows it in the local file only when that file answers', () => {
    expect(writePluginSettingsText({}, 'local', KNOWN)).not.toMatch(/plugins:/)
    const written = writePluginSettingsText({ plugins: { reader: false } }, 'local', KNOWN)
    expect(parseSettingsText(written).plugins).toEqual({ reader: false })
  })
})

// A plugin with one setting of each file, for the settings below.
const MAIL: PluginInfo = {
  id: 'mail',
  label: 'Mail',
  default: true,
  settings: [
    {
      key: 'view',
      label: 'View',
      explanation: 'How it opens.',
      type: {
        kind: 'enum',
        options: [
          { value: 'list', label: 'List' },
          { value: 'grid', label: 'Grid' },
        ],
      },
      default: 'list',
      target: 'local',
    },
    {
      key: 'senders',
      label: 'Senders',
      explanation: 'Who may load images.',
      type: { kind: 'list' },
      default: [],
      target: 'local',
    },
    {
      key: 'signature',
      label: 'Signature',
      explanation: 'Under every mail.',
      type: { kind: 'text' },
      default: '',
      target: 'committed',
    },
  ],
}

describe("a plugin's own settings", () => {
  it('answers each key from the last file that names it, else its default', () => {
    const r = resolvePluginSettings(
      'mail:\n  view: grid\n  signature: Ada\n',
      'mail:\n  view: list\n',
      [MAIL],
    )
    expect(r.values.mail).toEqual({ view: 'list', senders: [], signature: 'Ada' })
    expect(pluginSettingValue({}, MAIL, 'view')).toBe('list')
  })

  it('drops a value its type refuses, with a warning, and keeps the default', () => {
    const r = resolvePluginSettings('mail:\n  view: tiles\n  senders: nope\n', null, [MAIL])
    expect(r.values.mail).toEqual({ view: 'list', senders: [], signature: '' })
    expect(r.warnings.filter((w) => w.includes('"mail.'))).toHaveLength(2)
  })

  it('writes only declared, valid keys of known plugins', () => {
    const { patch, warnings } = parsePluginSettingsPatch(
      JSON.stringify({
        mail: { view: 'grid', colour: 'red', senders: ['ada@syv.ai'] },
        stranger: { x: 1 },
      }),
      [MAIL],
    )
    expect(patch).toEqual({ mail: { view: 'grid', senders: ['ada@syv.ai'] } })
    expect(warnings.some((w) => w.includes('"mail.colour"'))).toBe(true)
  })

  it('lists each file its own settings, commented until answered, and reads back what it wrote', () => {
    const local = writePluginSettingsText({ mail: { senders: ['ada@syv.ai'] } }, 'local', [MAIL])
    expect(local).toContain('  # view: list')
    expect(local).not.toContain('signature:')
    expect(resolvePluginSettings(null, local, [MAIL]).values.mail!.senders).toEqual(['ada@syv.ai'])
    const committed = writePluginSettingsText({}, 'committed', [MAIL])
    expect(committed).toContain('# mail:')
    expect(parseSettingsText(committed).mail).toBeUndefined()
  })

  it('refuses a declared default its own type refuses', () => {
    const bad: PluginInfo = { ...MAIL, settings: [{ ...MAIL.settings![0]!, default: 'tiles' }] }
    expect(() => checkPluginCatalogue([bad])).toThrow('default')
  })
})
