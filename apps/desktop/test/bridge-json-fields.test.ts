import { describe, expect, it } from 'vitest'
import { projectJsonFields } from '../src/main/bridge/json-fields'

describe('JSON field projection', () => {
  it('projects nested objects and arrays and preserves root array order', () => {
    const input = [
      { id: 1, thread: { subject: 'first', ignored: true } },
      { id: 2, thread: { subject: 'second', ignored: true } },
    ]
    expect(projectJsonFields(input, [['id'], ['thread', 'subject']])).toEqual([
      { id: 1, thread: { subject: 'first' } },
      { id: 2, thread: { subject: 'second' } },
    ])
  })

  it('is order-independent for overlapping paths and keeps the selected parent whole', () => {
    const input = { thread: { id: 't1', subject: 'subject', extra: [1, 2] } }
    const expected = { thread: { id: 't1', subject: 'subject', extra: [1, 2] } }
    expect(projectJsonFields(input, [['thread'], ['thread', 'id']])).toEqual(expected)
    expect(projectJsonFields(input, [['thread', 'id'], ['thread']])).toEqual(expected)
  })

  it('omits missing properties but deterministically preserves null and scalar array positions', () => {
    expect(
      projectJsonFields(
        { records: [{ id: 0, absent: undefined, enabled: false }, null, false, 0, { absent: 3 }] },
        [
          ['records', 'id'],
          ['records', 'absent'],
          ['records', 'enabled'],
        ],
      ),
    ).toEqual({
      records: [{ id: 0, absent: undefined, enabled: false }, null, null, null, { absent: 3 }],
    })
    expect(projectJsonFields(null, [['a']])).toBeNull()
    expect(projectJsonFields(false, [['a']])).toBeNull()
    expect(projectJsonFields(0, [['a']])).toBeNull()
  })

  it('returns selected fenced strings byte-for-byte', () => {
    const fenced = '```untrusted\n  keep spacing\n```'
    expect(projectJsonFields({ body: fenced }, [['body']])).toEqual({ body: fenced })
  })

  it('uses own properties only and does not mutate source data', () => {
    const inherited = { inherited: 'no' }
    const input = Object.assign(Object.create(inherited) as Record<string, unknown>, {
      own: { value: 'yes', untouched: true },
    })
    const before = structuredClone(input)
    expect(projectJsonFields(input, [['inherited'], ['own', 'value']])).toEqual({
      own: { value: 'yes' },
    })
    expect(input).toEqual(before)
    expect(Object.hasOwn(input, 'inherited')).toBe(false)
  })
})
