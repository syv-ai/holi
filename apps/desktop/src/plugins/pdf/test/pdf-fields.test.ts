import type { TemplateField } from '../shared/template-fields'
import { describe, expect, it } from 'vitest'
import { fieldValuesFor, metaFromValues, missingRequired } from '../shared/pdf-fields'

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

const today = '2026-08-04'

/** Seed `fields` from a note, the one way the dialog and the CLI both do. */
const fill = (fields: TemplateField[], text: string, path = 'a.md') =>
  fieldValuesFor(fields, path, text, today)

describe('fieldValuesFor: frontmatter', () => {
  it('reads a leading YAML map, and nothing when there is none', () => {
    const fields = [field({ key: 'title' }), field({ key: 'year' })]
    expect(fill(fields, '---\ntitle: Report\nyear: 2026\n---\n\nbody\n')).toEqual({
      title: 'Report',
      year: '2026',
    })
    expect(fill(fields, 'body\n')).toEqual({ title: '', year: '' })
  })

  it('ignores invalid YAML or a frontmatter that is not a map, rather than throwing', () => {
    const fields = [field({ key: 'tags' })]
    expect(fill(fields, '---\ntags: [unterminated\n---\nbody\n')).toEqual({ tags: '' })
    expect(fill(fields, '---\n- a\n- b\n---\nbody\n')).toEqual({ tags: '' })
  })

  it('overlays frontmatter on the type default, coerced by field type', () => {
    const fields = [
      field({ key: 'title', type: 'text' }),
      field({ key: 'count', type: 'number' }),
      field({ key: 'urgent', type: 'checkbox' }),
    ]
    expect(fill(fields, '---\ntitle: Q3 Report\ncount: 42\nurgent: true\n---\n')).toEqual({
      title: 'Q3 Report',
      count: '42',
      urgent: 'true',
    })
  })

  it('formats an unquoted date as YYYY-MM-DD and passes a quoted one through', () => {
    const fields = [field({ key: 'date', type: 'date' })]
    expect(fill(fields, '---\ndate: 2026-07-08\n---\n')).toEqual({ date: '2026-07-08' })
    expect(fill(fields, '---\ndate: "2026-01-02"\n---\n')).toEqual({ date: '2026-01-02' })
  })

  it('falls back to the type default when the key is absent', () => {
    const fields = [field({ key: 'date', type: 'date' }), field({ key: 'to', type: 'text' })]
    expect(fill(fields, '---\nx: 1\n---\n')).toEqual({ date: today, to: '' })
  })

  it('ignores array/object/null values and keeps the default', () => {
    const fields = [field({ key: 'to', type: 'text' })]
    expect(fill(fields, '---\nto: [a, b]\n---\n')).toEqual({ to: '' })
    expect(fill(fields, '---\nto: { x: 1 }\n---\n')).toEqual({ to: '' })
    expect(fill(fields, '---\nto: null\n---\n')).toEqual({ to: '' })
  })

  it('never seeds a key the template does not declare (no leak)', () => {
    const fields = [field({ key: 'title', type: 'text' })]
    expect(fill(fields, '---\ntitle: T\nrecipient: ACME\n---\n')).toEqual({ title: 'T' })
  })
})

describe('fieldValuesFor: what the note says', () => {
  const fields = [field({ key: 'title', type: 'text' }), field({ key: 'client', type: 'text' })]

  it('reads the title off the opening H1 and the client off kunder/<client>/', () => {
    const note = '# Market analysis\n\nBody\n'
    const expected = { title: 'Market analysis', client: 'Acme' }
    expect(fill(fields, note, 'kunder/Acme/reports/analysis.md')).toEqual(expected)
    expect(fill(fields, note, 'kunder/Acme/analysis.md')).toEqual(expected)
  })

  it('has no client outside a client folder of kunder/', () => {
    const none = { title: '', client: '' }
    expect(fill(fields, '', 'kunder/analysis.md')).toEqual(none)
    expect(fill(fields, '', 'notes/kunder/Acme/a.md')).toEqual(none)
    expect(fill(fields, '', 'analysis.md')).toEqual(none)
  })

  it('takes the H1 only when the note opens with it, past frontmatter', () => {
    const title = (text: string) => fill(fields, text).title
    expect(title('---\nx: 1\n---\n\n# Title #\n')).toBe('Title')
    expect(title('Intro\n\n# Later\n')).toBe('')
    expect(title('## Section\n')).toBe('')
    expect(title('#\n')).toBe('')
  })

  it('reads frontmatter first, then the H1 and client folder', () => {
    const note = '---\nclient: Beta\n---\n# Analysis\n'
    expect(fill(fields, note, 'kunder/Acme/a.md')).toEqual({ title: 'Analysis', client: 'Beta' })
    expect(fill(fields, '---\ntitle: FM\n---\n# From H1\n', 'kunder/Acme/a.md')).toEqual({
      title: 'FM',
      client: 'Acme',
    })
  })

  it('leaves a field with its own default, or of another type, alone', () => {
    const own = [
      field({ key: 'title', type: 'text', default: 'Fixed' }),
      field({ key: 'client', type: 'select', options: ['Acme', 'Other'] }),
    ]
    expect(fill(own, '# From H1\n', 'kunder/Acme/a.md')).toEqual({ title: 'Fixed', client: '' })
  })

  it('prefills from the rest of a note whose frontmatter is unterminated', () => {
    expect(fill(fields, '---\nx: 1\n', 'kunder/Acme/a.md')).toEqual({ title: '', client: 'Acme' })
  })
})
