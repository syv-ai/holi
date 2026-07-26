import { describe, expect, it } from 'vitest'
import { initialValue, type TemplateField } from '../src/template-fields'

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
