import type { TemplateField } from '../shared/template-fields'
import { describe, expect, it } from 'vitest'
import {
  metaFromValues,
  missingRequired,
  noteValues,
  parseFrontmatter,
  prefillValues,
} from '../shared/pdf-fields'

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

describe('noteValues', () => {
  it('reads the title off the opening H1 and the client off kunder/<client>/', () => {
    const note = '# Market analysis\n\nBody\n'
    expect(noteValues('kunder/Acme/reports/analysis.md', note)).toEqual({
      title: 'Market analysis',
      client: 'Acme',
    })
    expect(noteValues('kunder/Acme/analysis.md', note)).toEqual({
      title: 'Market analysis',
      client: 'Acme',
    })
  })

  it('has no client outside a client folder of kunder/', () => {
    expect(noteValues('kunder/analysis.md', '')).toEqual({})
    expect(noteValues('notes/kunder/Acme/a.md', '')).toEqual({})
    expect(noteValues('analysis.md', '')).toEqual({})
  })

  it('takes the H1 only when the note opens with it, past frontmatter', () => {
    expect(noteValues('a.md', '---\nx: 1\n---\n\n# Title #\n')).toEqual({ title: 'Title' })
    expect(noteValues('a.md', 'Intro\n\n# Later\n')).toEqual({})
    expect(noteValues('a.md', '## Section\n')).toEqual({})
    expect(noteValues('a.md', '#\n')).toEqual({})
  })
})

describe('prefillValues with what the note says', () => {
  const today = '2026-07-01'
  const fromNote = { title: 'From H1', client: 'Acme' }

  it('fills text fields of those keys, frontmatter first', () => {
    const fields = [field({ key: 'title', type: 'text' }), field({ key: 'client', type: 'text' })]
    expect(prefillValues(fields, {}, today, fromNote)).toEqual(fromNote)
    expect(prefillValues(fields, { title: 'FM' }, today, fromNote)).toEqual({
      title: 'FM',
      client: 'Acme',
    })
  })

  it('leaves a field with its own default, or of another type, alone', () => {
    const fields = [
      field({ key: 'title', type: 'text', default: 'Fixed' }),
      field({ key: 'client', type: 'select', options: ['Acme', 'Other'] }),
    ]
    expect(prefillValues(fields, {}, today, fromNote)).toEqual({ title: 'Fixed', client: '' })
  })
})
