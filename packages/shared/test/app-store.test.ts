import { describe, expect, it } from 'vitest'
import {
  APP_LOG_MAX_ENTRIES,
  appendAppLog,
  formatRecord,
  isAppDataPath,
  isRecordId,
  mergeRecordText,
  newRecordId,
  recordRel,
  validateRecord,
  type CollectionSchema,
} from '../src/app-store'
import { parseAppManifest } from '../src/app-manifest'

describe('validateRecord', () => {
  const schema: CollectionSchema = {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 20 },
      status: { enum: ['todo', 'doing', 'done'] },
      points: { type: 'integer', minimum: 0, maximum: 13 },
      tags: { type: 'array', items: { type: 'string' } },
      due: { type: ['string', 'null'] },
    },
  }

  it('accepts a valid record', () => {
    expect(validateRecord(schema, { title: 'a', status: 'todo', points: 3, tags: ['x'] })).toEqual(
      [],
    )
    expect(validateRecord(schema, { title: 'a', due: null })).toEqual([])
  })

  it('names each problem with its path', () => {
    expect(validateRecord(schema, { status: 'later' })).toEqual([
      'title: is required',
      'status: must be one of todo, doing, done',
    ])
    expect(validateRecord(schema, { title: '', points: 2.5 })).toEqual([
      'title: must be at least 1 characters',
      'points: must be an integer',
    ])
    expect(validateRecord(schema, { title: 'a', points: 14, tags: ['x', 3] })).toEqual([
      'points: must be at most 13',
      'tags[1]: must be a string',
    ])
    expect(validateRecord(schema, { title: 'a', extra: 1 })).toEqual(['extra: is not allowed'])
  })

  it('ignores keywords outside the subset', () => {
    expect(validateRecord({ type: 'object', pattern: '^x' } as CollectionSchema, { a: 1 })).toEqual(
      [],
    )
  })

  it('needs a plain object whatever the schema says, and nothing else without one', () => {
    expect(validateRecord(undefined, { anything: [1, 2] })).toEqual([])
    expect(validateRecord(undefined, [1])).toEqual(['record: must be an object'])
    expect(validateRecord(undefined, 'x')).toEqual(['record: must be an object'])
    expect(validateRecord(undefined, null)).toEqual(['record: must be an object'])
  })
})

describe('record ids', () => {
  it('accepts readable keys, dates included', () => {
    for (const id of ['2026-09-30', 'a', 'x_y.z', 'A'.repeat(128)])
      expect(isRecordId(id)).toBe(true)
  })

  it('refuses what could escape, hide or stay local', () => {
    for (const id of ['', '.', '..', '../x', 'a/b', '.x', 'a.local.b', 'a b', 'A'.repeat(129)]) {
      expect(isRecordId(id)).toBe(false)
    }
  })

  it('generates a 26-char id that sorts by time', () => {
    const zero = () => new Uint8Array(16)
    const a = newRecordId(1_000, zero)
    const b = newRecordId(2_000, zero)
    expect(a).toHaveLength(26)
    expect(isRecordId(a)).toBe(true)
    expect(a < b).toBe(true)
    expect(newRecordId()).not.toBe(newRecordId())
  })

  it('lays a record out inside its bundle', () => {
    expect(recordRel('Work/Tracker.app', 'items', '2026-09-30')).toBe(
      'Work/Tracker.app/data/items/2026-09-30.json',
    )
  })
})

describe('formatRecord', () => {
  it('is the same bytes whatever the key order', () => {
    expect(formatRecord({ b: 1, a: { d: 2, c: [{ f: 1, e: 2 }] } })).toBe(
      formatRecord({ a: { c: [{ e: 2, f: 1 }], d: 2 }, b: 1 }),
    )
    expect(formatRecord({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n')
  })
})

describe('mergeRecordText', () => {
  const f = formatRecord
  const base = f({ title: 'a', done: false, points: 1 })

  it('keeps both sides when they changed different fields', () => {
    const ours = f({ title: 'a', done: true, points: 1 })
    const theirs = f({ title: 'b', done: false, points: 1 })
    expect(mergeRecordText(base, ours, theirs)).toEqual({
      ok: true,
      text: f({ title: 'b', done: true, points: 1 }),
    })
  })

  it('merges a removed field like an edit', () => {
    const ours = f({ title: 'a', done: false })
    const theirs = f({ title: 'a', done: true, points: 1 })
    expect(mergeRecordText(base, ours, theirs)).toEqual({
      ok: true,
      text: f({ title: 'a', done: true }),
    })
  })

  it('takes a change both sides made identically', () => {
    const both = f({ title: 'c', done: false, points: 1 })
    expect(mergeRecordText(base, both, both)).toEqual({ ok: true, text: both })
  })

  it('conflicts when both sides changed the same field differently', () => {
    const ours = f({ title: 'x', done: false, points: 1 })
    const theirs = f({ title: 'y', done: false, points: 1 })
    expect(mergeRecordText(base, ours, theirs)).toEqual({
      ok: false,
      reason: 'both changed: title',
    })
  })

  it('merges two additions of one id only where they do not overlap', () => {
    expect(mergeRecordText(null, f({ a: 1 }), f({ b: 2 }))).toEqual({
      ok: true,
      text: f({ a: 1, b: 2 }),
    })
    expect(mergeRecordText(null, f({ a: 1 }), f({ a: 1 }))).toEqual({ ok: true, text: f({ a: 1 }) })
    expect(mergeRecordText(null, f({ a: 1 }), f({ a: 2 }))).toEqual({
      ok: false,
      reason: 'both changed: a',
    })
  })

  it('refuses anything that is not a JSON object', () => {
    expect(mergeRecordText(base, '{', base).ok).toBe(false)
    expect(mergeRecordText(base, base, '[1]').ok).toBe(false)
  })
})

describe('keys that are also Object.prototype names', () => {
  it('are fields like any other', () => {
    const json = '{"__proto__": {"x": 1}, "constructor": 2}'
    const value = JSON.parse(json) as Record<string, unknown>
    expect(JSON.parse(formatRecord(value))).toEqual(value)
    expect(Object.keys(JSON.parse(formatRecord(value)))).toEqual(['__proto__', 'constructor'])
    expect(validateRecord({ type: 'object', required: ['constructor'] }, {})).toEqual([
      'constructor: is required',
    ])
    expect(
      validateRecord({ type: 'object', additionalProperties: false }, { toString: 1 }),
    ).toEqual(['toString: is not allowed'])
    const merged = mergeRecordText('{}', '{"__proto__": 1}', '{"constructor": 2}')
    expect(merged.ok && JSON.parse(merged.text)).toEqual(
      JSON.parse('{"__proto__": 1, "constructor": 2}'),
    )
  })

  it('never declare a collection by being inherited', () => {
    expect(parseAppManifest('collections:\n  __proto__: {}\n  items: {}\n')).toEqual({
      collections: { items: {} },
    })
  })
})

describe('isAppDataPath', () => {
  it('is the data folder at the bundle root, in any case', () => {
    expect(isAppDataPath('data/items/a.json')).toBe(true)
    expect(isAppDataPath('Data/items/a.json')).toBe(true)
    expect(isAppDataPath('DATA')).toBe(true)
    expect(isAppDataPath('database.js')).toBe(false)
    expect(isAppDataPath('lib/data/x.js')).toBe(false)
  })
})

describe('appendAppLog', () => {
  const at = (iso: string) => new Date(iso)

  it('appends one entry per line, a stack continuing indented', () => {
    const one = appendAppLog(
      null,
      { level: 'error', text: 'boom\n  at f()' },
      at('2026-10-01T10:00:00Z'),
    )
    expect(one).toBe('2026-10-01T10:00:00.000Z error boom\n    at f()\n')
    const two = appendAppLog(one, { level: 'info', text: 'ok' }, at('2026-10-01T10:01:00Z'))
    expect(two.split('\n').filter((l) => /^\d{4}/.test(l))).toHaveLength(2)
  })

  it('drops what is past its day, stack and all', () => {
    const old = appendAppLog(
      null,
      { level: 'error', text: 'old\nstack' },
      at('2026-09-29T10:00:00Z'),
    )
    const next = appendAppLog(old, { level: 'warn', text: 'new' }, at('2026-10-01T10:00:00Z'))
    expect(next).toBe('2026-10-01T10:00:00.000Z warn new\n')
  })

  it('keeps at most the cap, newest last', () => {
    let log: string | null = null
    for (let i = 0; i < APP_LOG_MAX_ENTRIES + 5; i++) {
      log = appendAppLog(log, { level: 'info', text: `n${i}` }, at('2026-10-01T10:00:00Z'))
    }
    const lines = log!.trimEnd().split('\n')
    expect(lines).toHaveLength(APP_LOG_MAX_ENTRIES)
    expect(lines.at(-1)).toContain(`n${APP_LOG_MAX_ENTRIES + 4}`)
  })
})
