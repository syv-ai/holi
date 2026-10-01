import { describe, expect, it } from 'vitest'
import { formatRecord, isAppDataPath, mergeRecordText } from '../src/app-store'

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
    const merged = mergeRecordText('{}', '{"__proto__": 1}', '{"constructor": 2}')
    expect(merged.ok && JSON.parse(merged.text)).toEqual(
      JSON.parse('{"__proto__": 1, "constructor": 2}'),
    )
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
