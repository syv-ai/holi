import { describe, expect, it } from 'vitest'
import { initialValue, parseFields, type TemplateField } from '../src/template-fields'

const f = (over: Partial<TemplateField>): TemplateField => ({
  key: 'k',
  label: 'K',
  type: 'text',
  required: false,
  ...over,
})
const TODAY = '2026-07-26'

describe('initialValue', () => {
  it('a date field with no default prefills to today', () => {
    expect(initialValue(f({ type: 'date' }), TODAY)).toBe(TODAY)
  })
  it('a date field with default "today" resolves the token', () => {
    expect(initialValue(f({ type: 'date', default: 'today' }), TODAY)).toBe(TODAY)
  })
  it('a date field with a literal default keeps the literal', () => {
    expect(initialValue(f({ type: 'date', default: '2020-01-01' }), TODAY)).toBe('2020-01-01')
  })
  it('a default of "" forces a blank prefill', () => {
    expect(initialValue(f({ type: 'date', default: '' }), TODAY)).toBe('')
  })
  it('a checkbox with no default starts unchecked ("false")', () => {
    expect(initialValue(f({ type: 'checkbox' }), TODAY)).toBe('false')
  })
  it('a checkbox default is honored', () => {
    expect(initialValue(f({ type: 'checkbox', default: 'true' }), TODAY)).toBe('true')
  })
  it('text/select/number without a default start blank', () => {
    expect(initialValue(f({ type: 'text' }), TODAY)).toBe('')
    expect(initialValue(f({ type: 'select' }), TODAY)).toBe('')
    expect(initialValue(f({ type: 'number' }), TODAY)).toBe('')
  })
  it('a literal default is used for a non-date field ("today" stays literal)', () => {
    expect(initialValue(f({ type: 'text', default: 'today' }), TODAY)).toBe('today')
    expect(initialValue(f({ type: 'text', default: 'Acme' }), TODAY)).toBe('Acme')
  })
})

describe('parseFields', () => {
  it('a clean manifest yields no warnings', () => {
    const { fields, warnings } = parseFields([
      { key: 'title', type: 'text' },
      { key: 'kind', type: 'select', options: ['a', 'b'] },
      { key: 'date', type: 'date', default: 'today' },
      { key: 'done', type: 'checkbox' },
    ])
    expect(warnings).toEqual([])
    expect(fields.map((x) => x.key)).toEqual(['title', 'kind', 'date', 'done'])
    expect(fields[1]).toMatchObject({ type: 'select', options: ['a', 'b'] })
  })

  it('an ABSENT type becomes text with no warning (the legacy path)', () => {
    const { fields, warnings } = parseFields([{ key: 'a' }])
    expect(fields).toEqual([{ key: 'a', label: 'a', type: 'text', required: false }])
    expect(warnings).toEqual([])
  })

  it('a present-but-invalid type degrades to text and warns', () => {
    const { fields, warnings } = parseFields([{ key: 'a', type: 'colour' }])
    expect(fields[0]!.type).toBe('text')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('a')
    expect(warnings[0]).toContain('colour')
  })

  it('a select without usable options degrades to text and warns', () => {
    for (const bad of [
      { key: 'a', type: 'select' },
      { key: 'a', type: 'select', options: [] },
    ]) {
      const { fields, warnings } = parseFields([bad])
      expect(fields[0]!.type).toBe('text')
      expect(fields[0]!.options).toBeUndefined()
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain('select')
    }
  })

  it('a missing or non-string key is dropped and warned by index', () => {
    const { fields, warnings } = parseFields([{ type: 'text' }, { key: 5 }])
    expect(fields).toEqual([])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('#0')
    expect(warnings[1]).toContain('#1')
  })

  it('a non-object entry is dropped and warned by index', () => {
    const { fields, warnings } = parseFields([null, 'x', 42])
    expect(fields).toEqual([])
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('#0')
  })

  it('a bad date default is stripped and warned; good ones are kept silently', () => {
    const bad = parseFields([{ key: 'd', type: 'date', default: '2026-13-40' }])
    expect(bad.fields[0]!.default).toBeUndefined()
    expect(bad.warnings).toHaveLength(1)
    expect(bad.warnings[0]).toContain('d')

    for (const good of ['today', '', '2026-07-27']) {
      const { fields, warnings } = parseFields([{ key: 'd', type: 'date', default: good }])
      expect(fields[0]!.default).toBe(good)
      expect(warnings).toEqual([])
    }
  })

  it('non-array raw yields empty fields and no warnings', () => {
    expect(parseFields(null)).toEqual({ fields: [], warnings: [] })
    expect(parseFields('x')).toEqual({ fields: [], warnings: [] })
  })
})
