import { describe, expect, it } from 'vitest'
import { APP_MANIFEST_FILE, parseAppManifest } from '../src/app-manifest'

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
