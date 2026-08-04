import type { TemplateField } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  metaFromValues,
  missingRequired,
  parseFrontmatter,
  prefillValues,
} from '../src/renderer/src/lib/pdf-fields'

const field = (over: Partial<TemplateField>): TemplateField => ({
  key: 'k',
  label: 'K',
  type: 'text',
  required: false,
  ...over,
})

describe('missingRequired', () => {
  it('flags required fields that are blank or whitespace-only', () => {
    const fields = [
      field({ key: 'a', required: true }),
      field({ key: 'b', required: true }),
      field({ key: 'c', required: false }),
    ]
    const values = { a: '', b: '   ', c: '' }
    expect(missingRequired(fields, values).map((f) => f.key)).toEqual(['a', 'b'])
  })

  it('never flags a checkbox, even when required and unset', () => {
    const fields = [field({ key: 'agree', type: 'checkbox', required: true })]
    expect(missingRequired(fields, { agree: 'false' })).toEqual([])
  })

  it('treats a filled required field as satisfied', () => {
    const fields = [field({ key: 'a', required: true })]
    expect(missingRequired(fields, { a: 'x' })).toEqual([])
  })
})

describe('metaFromValues', () => {
  it('emits every declared field, defaulting absent ones to empty', () => {
    const fields = [field({ key: 'a' }), field({ key: 'b' })]
    expect(metaFromValues(fields, { a: 'x' })).toEqual({ a: 'x', b: '' })
  })

  it('ignores values for fields the template does not declare', () => {
    const fields = [field({ key: 'a' })]
    expect(metaFromValues(fields, { a: 'x', stray: 'y' })).toEqual({ a: 'x' })
  })
})

describe('parseFrontmatter', () => {
  it('returns {} when there is no frontmatter', () => {
    expect(parseFrontmatter('# just a heading\n\nbody\n')).toEqual({})
  })

  it('parses a leading YAML map', () => {
    expect(parseFrontmatter('---\ntitle: Report\nyear: 2026\n---\n\nbody\n')).toEqual({
      title: 'Report',
      year: 2026,
    })
  })

  it('returns {} on invalid YAML rather than throwing', () => {
    expect(parseFrontmatter('---\ntags: [unterminated\n---\nbody\n')).toEqual({})
  })

  it('returns {} when the frontmatter is not a map', () => {
    expect(parseFrontmatter('---\n- a\n- b\n---\nbody\n')).toEqual({})
  })
})

describe('prefillValues', () => {
  const today = '2026-08-04'

  it('overlays frontmatter on the type default, coerced by field type', () => {
    const fields = [
      field({ key: 'title', type: 'text' }),
      field({ key: 'count', type: 'number' }),
      field({ key: 'urgent', type: 'checkbox' }),
    ]
    const fm = { title: 'Q3 Report', count: 42, urgent: true }
    expect(prefillValues(fields, fm, today)).toEqual({
      title: 'Q3 Report',
      count: '42',
      urgent: 'true',
    })
  })

  it('formats a Date-typed frontmatter value as YYYY-MM-DD for a date field', () => {
    const fields = [field({ key: 'date', type: 'date' })]
    // yaml parses an unquoted ISO date to a JS Date.
    const fm = parseFrontmatter('---\ndate: 2026-07-08\n---\n')
    expect(prefillValues(fields, fm, today)).toEqual({ date: '2026-07-08' })
  })

  it('passes a date string through unchanged', () => {
    const fields = [field({ key: 'date', type: 'date' })]
    expect(prefillValues(fields, { date: '2026-01-02' }, today)).toEqual({ date: '2026-01-02' })
  })

  it('falls back to initialValue when the key is absent', () => {
    const fields = [field({ key: 'date', type: 'date' }), field({ key: 'to', type: 'text' })]
    expect(prefillValues(fields, {}, today)).toEqual({ date: today, to: '' })
  })

  it('ignores array/object/null values and keeps the default', () => {
    const fields = [field({ key: 'to', type: 'text' })]
    expect(prefillValues(fields, { to: ['a', 'b'] }, today)).toEqual({ to: '' })
    expect(prefillValues(fields, { to: { x: 1 } }, today)).toEqual({ to: '' })
    expect(prefillValues(fields, { to: null }, today)).toEqual({ to: '' })
  })

  it('never seeds a key the template does not declare (no leak)', () => {
    const fields = [field({ key: 'title', type: 'text' })]
    expect(prefillValues(fields, { title: 'T', recipient: 'ACME' }, today)).toEqual({ title: 'T' })
  })
})
