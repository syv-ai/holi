import type { TemplateField } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import { coerceMeta, composeWrapper, typstString } from '../src/main/pdf/wrapper'

const f = (over: Partial<TemplateField>): TemplateField => ({
  key: 'k',
  label: 'K',
  type: 'text',
  required: false,
  ...over,
})

describe('typstString', () => {
  it('wraps in quotes and escapes backslashes and quotes', () => {
    expect(typstString('a"b\\c')).toBe('"a\\"b\\\\c"')
  })
})

describe('coerceMeta', () => {
  it('renders no fields as the empty-dict literal (:)', () => {
    expect(coerceMeta([], {})).toBe('(:)')
  })
  it('text/textarea/select values become quoted strings', () => {
    const fields = [f({ key: 'to', type: 'text' }), f({ key: 's', type: 'select', options: ['A'] })]
    expect(coerceMeta(fields, { to: 'ACME', s: 'A' })).toBe('(to: "ACME", s: "A")')
  })
  it('a number value is an unquoted numeric literal', () => {
    expect(coerceMeta([f({ key: 'n', type: 'number' })], { n: '3' })).toBe('(n: 3)')
    expect(coerceMeta([f({ key: 'n', type: 'number' })], { n: '3.5' })).toBe('(n: 3.5)')
  })
  it('an invalid number throws', () => {
    expect(() => coerceMeta([f({ key: 'n', type: 'number' })], { n: 'x' })).toThrow(/number/)
  })
  it('a checkbox is always present as true/false, defaulting to false', () => {
    expect(coerceMeta([f({ key: 'b', type: 'checkbox' })], { b: 'true' })).toBe('(b: true)')
    expect(coerceMeta([f({ key: 'b', type: 'checkbox' })], { b: 'false' })).toBe('(b: false)')
    expect(coerceMeta([f({ key: 'b', type: 'checkbox' })], {})).toBe('(b: false)')
  })
  it('a date becomes a native datetime literal', () => {
    expect(coerceMeta([f({ key: 'd', type: 'date' })], { d: '2026-07-26' })).toBe(
      '(d: datetime(year: 2026, month: 7, day: 26))',
    )
  })
  it('an invalid date throws', () => {
    expect(() => coerceMeta([f({ key: 'd', type: 'date' })], { d: 'nope' })).toThrow(/date/)
  })
  it('blank optional values are omitted (checkbox excepted)', () => {
    const fields = [f({ key: 'to', type: 'text' }), f({ key: 'b', type: 'checkbox' })]
    expect(coerceMeta(fields, { to: '', b: 'false' })).toBe('(b: false)')
  })
})

describe('composeWrapper', () => {
  it('imports the template and calls doc with the coerced meta', () => {
    const out = composeWrapper({
      templateDir: '/v/.holi/templates/plain',
      notePath: '/v/notes/report.md',
      assetsDir: '/v/.holi/templates/plain/assets',
      fields: [f({ key: 'to', type: 'text' })],
      meta: { to: 'ACME' },
    })
    expect(out).toBe(
      '#import "/v/.holi/templates/plain/template.typ": doc\n' +
        '#doc("/v/notes/report.md", meta: (to: "ACME"), assets: "/v/.holi/templates/plain/assets")\n',
    )
  })
})
