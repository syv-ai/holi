import { describe, expect, it } from 'vitest'
import { APP_MANIFEST_FILE, appManifestText, parseAppManifest } from '../src/app-manifest'

describe('APP_MANIFEST_FILE', () => {
  it('is app.yaml', () => {
    expect(APP_MANIFEST_FILE).toBe('app.yaml')
  })
})

describe('parseAppManifest', () => {
  it('keeps a description', () => {
    expect(parseAppManifest('description: Sprint retros, on the wall\n')).toEqual({
      description: 'Sprint retros, on the wall',
    })
  })

  it('accepts an empty manifest — registering is its whole job', () => {
    expect(parseAppManifest('')).toEqual({})
    expect(parseAppManifest('   \n\n')).toEqual({})
    expect(parseAppManifest('# just a comment\n')).toEqual({})
  })

  it('drops unknown keys rather than erroring, including the retired name and icon', () => {
    expect(parseAppManifest('name: Retro\nicon: kanban\ndescription: d\nversion: 3\n')).toEqual({
      description: 'd',
    })
  })

  it('drops a field whose value is the wrong type', () => {
    expect(parseAppManifest('description: 42\n')).toEqual({})
    expect(parseAppManifest('description:\n  - a\n')).toEqual({})
  })

  it('returns {} for malformed YAML — a typo costs a field, never the app', () => {
    expect(parseAppManifest('description: "unterminated\n')).toEqual({})
    expect(parseAppManifest('a:\n b: c\n  d: e\n')).toEqual({})
  })

  it('returns null when the document is not a mapping at all', () => {
    expect(parseAppManifest('- a\n- b\n')).toBeNull()
    expect(parseAppManifest('42')).toBeNull()
    expect(parseAppManifest('just a bare string')).toBeNull()
    expect(parseAppManifest('null')).toBeNull()
  })
})

describe('parseAppManifest collections', () => {
  it('reads a map of collections, each with an optional schema', () => {
    const yaml = [
      'description: d',
      'collections:',
      '  items:',
      '    schema:',
      '      type: object',
      '      required: [title]',
      '  notes: {}',
      '',
    ].join('\n')
    expect(parseAppManifest(yaml)).toEqual({
      description: 'd',
      collections: {
        items: { schema: { type: 'object', required: ['title'] } },
        notes: {},
      },
    })
  })

  it('reads a list as schema-less collections', () => {
    expect(parseAppManifest('collections: [items, notes]\n')).toEqual({
      collections: { items: {}, notes: {} },
    })
  })

  it('drops a collection with an unusable name, and a schema that is not a mapping', () => {
    const yaml = [
      'collections:',
      '  ../x: {}',
      '  a.local.b: {}',
      '  items:',
      '    schema: 42',
      '',
    ].join('\n')
    expect(parseAppManifest(yaml)).toEqual({ collections: { items: {} } })
  })
})

describe('parseAppManifest dangerously-allow', () => {
  it('reads the list of opted-in affordances', () => {
    expect(parseAppManifest('dangerously-allow: [mail, calendar]\n')).toEqual({
      dangerouslyAllow: ['mail', 'calendar'],
    })
  })

  it('drops an unknown affordance and keeps the rest', () => {
    expect(parseAppManifest('dangerously-allow: [mail, drive, 3]\n')).toEqual({
      dangerouslyAllow: ['mail'],
    })
  })

  it('ignores a value that is not a list', () => {
    expect(parseAppManifest('dangerously-allow: mail\n')).toEqual({})
    expect(parseAppManifest('dangerously-allow: [drive]\n')).toEqual({})
  })
})

describe('appManifestText', () => {
  // Every key is written out; the blank ones must read as unused.
  it('reads back as the manifest it describes', () => {
    expect(parseAppManifest(appManifestText())).toEqual({})
    expect(parseAppManifest(appManifestText('Says: "hi"'))).toEqual({ description: 'Says: "hi"' })
  })
})
