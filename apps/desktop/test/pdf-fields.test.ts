import type { TemplateField } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import { metaFromValues, missingRequired } from '../src/renderer/src/lib/pdf-fields'

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
