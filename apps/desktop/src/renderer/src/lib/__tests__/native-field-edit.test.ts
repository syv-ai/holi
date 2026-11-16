import { describe, expect, it } from 'vitest'
import { setFieldSelection, supportsNativeFieldSelection } from '@/lib/native-field-edit'

describe('native field selection support', () => {
  it('excludes input types whose selection APIs throw', () => {
    for (const type of ['email', 'date', 'password', 'number', 'color']) {
      const field = document.createElement('input')
      field.type = type
      field.value = 'unchanged'
      const before = field.value
      expect(supportsNativeFieldSelection(field), type).toBe(false)
      expect(() => setFieldSelection(field, 0, 1)).not.toThrow()
      expect(field.value).toBe(before)
    }
  })

  it('supports selectable text inputs and textareas', () => {
    const field = document.createElement('input')
    field.type = 'search'
    expect(supportsNativeFieldSelection(field)).toBe(true)
    expect(supportsNativeFieldSelection(document.createElement('textarea'))).toBe(true)
  })
})
