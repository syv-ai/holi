/**
 * Where a drop lands, as numbers.
 *
 * The component that hit-tests a drag cannot be tested doing it: jsdom computes
 * no layout, so every `getBoundingClientRect` is `0×0` (`test/setup.dom.ts` says
 * so at length, and parks the resizable handles far from the origin to prove
 * it). Lifting the arithmetic out is therefore not tidiness — it is the only
 * form of this logic that can be checked at all. Same split `tab-window.ts`
 * made: the clip is a stylesheet's job, the decision is not.
 */
import { describe, expect, it } from 'vitest'
import {
  dropIndex,
  paneDropZone,
  parseTabPayload,
  stripEdge,
  tabPayload,
  type PillBox,
} from '../src/renderer/src/lib/tab-drop'

/** Three pills, 100px each, starting at x=100 — and carrying **absolute** tab
 *  indices 4/5/6, because the strip renders a window and the leftmost visible
 *  pill is very often not tab 0. */
const pills: PillBox[] = [
  { index: 4, left: 100, width: 100 },
  { index: 5, left: 200, width: 100 },
  { index: 6, left: 300, width: 100 },
]

describe('dropIndex', () => {
  it('lands before a pill on its left half, and after it on its right', () => {
    expect(dropIndex(pills, 120)).toBe(4)
    expect(dropIndex(pills, 180)).toBe(5)
  })

  it('flips exactly at the midpoint', () => {
    expect(dropIndex(pills, 249)).toBe(5)
    expect(dropIndex(pills, 251)).toBe(6)
  })

  it('returns absolute indices, not rendered offsets', () => {
    // The bug this function exists to prevent: a caret computed against the
    // rendered offset reorders the wrong tab the moment anything is clipped.
    expect(dropIndex(pills, 0)).toBe(4)
    expect(dropIndex(pills, 120)).not.toBe(0)
  })

  it('means "after the last visible pill", not "the end of the strip"', () => {
    // There may be hidden tabs beyond it. The caret is where the caret is, and
    // this function is not told how many tabs exist — by design.
    expect(dropIndex(pills, 500)).toBe(7)
  })

  it('is 0 for an empty strip', () => {
    expect(dropIndex([], 250)).toBe(0)
  })
})

describe('paneDropZone', () => {
  it('splits a narrow pane at a quarter of its width', () => {
    // 179px per pane is the split actually observed in the 2026-08-20
    // verification, with the agent drawer open in a 1200px window.
    const rect = { left: 0, width: 179 }

    expect(paneDropZone(rect, 0)).toBe('before')
    expect(paneDropZone(rect, 44)).toBe('before')
    expect(paneDropZone(rect, 45)).toBe('into')
    expect(paneDropZone(rect, 90)).toBe('into')
    expect(paneDropZone(rect, 134)).toBe('into')
    expect(paneDropZone(rect, 135)).toBe('after')
  })

  it('caps the edge on a wide pane, instead of making half the window a target', () => {
    const rect = { left: 0, width: 1200 }

    expect(paneDropZone(rect, 119)).toBe('before')
    expect(paneDropZone(rect, 121)).toBe('into')
    // Uncapped this would still be 'before' — a quarter of 1200 is 300px.
    expect(paneDropZone(rect, 200)).toBe('into')
    expect(paneDropZone(rect, 1079)).toBe('into')
    expect(paneDropZone(rect, 1081)).toBe('after')
  })

  it('measures from the pane’s own left edge, not from the window’s', () => {
    const rect = { left: 500, width: 400 }

    expect(paneDropZone(rect, 510)).toBe('before')
    expect(paneDropZone(rect, 700)).toBe('into')
    expect(paneDropZone(rect, 890)).toBe('after')
  })
})

describe('stripEdge', () => {
  const rect = { left: 0, width: 400 }

  it('arms at either end and is null in between', () => {
    expect(stripEdge(rect, 5)).toBe('left')
    expect(stripEdge(rect, 200)).toBeNull()
    expect(stripEdge(rect, 395)).toBe('right')
  })

  it('has a band of 28px', () => {
    expect(stripEdge(rect, 27)).toBe('left')
    expect(stripEdge(rect, 28)).toBeNull()
    expect(stripEdge(rect, 372)).toBeNull()
    expect(stripEdge(rect, 373)).toBe('right')
  })
})

describe('the DataTransfer payload', () => {
  it('round-trips every kind of tab', () => {
    const tabs = [
      { kind: 'note', path: 'notes/a.md' },
      { kind: 'app', appId: 'burndown' },
      { kind: 'board' },
      { kind: 'agenda' },
      { kind: 'mail' },
    ] as const

    for (const tab of tabs) expect(parseTabPayload(tabPayload(tab))).toEqual(tab)
  })

  it('carries what a tab IS, never what state it is in', () => {
    // Identity only. `moveTab` does the pinning, from the tab it finds in the
    // workspace — so a stale `preview` flag on the wire could never contradict it.
    expect(parseTabPayload(tabPayload({ kind: 'note', path: 'a.md', preview: true }))).toEqual({
      kind: 'note',
      path: 'a.md',
    })
  })

  it('refuses anything that is not a tab', () => {
    // The trust boundary: this string crossed a DataTransfer, and any drag
    // source on the machine could have put something else there.
    expect(parseTabPayload('not json at all')).toBeNull()
    expect(parseTabPayload('"a bare string"')).toBeNull()
    expect(parseTabPayload('123')).toBeNull()
    expect(parseTabPayload('null')).toBeNull()
    expect(parseTabPayload('[]')).toBeNull()
    expect(parseTabPayload('{"kind":"nope"}')).toBeNull()
  })

  it('refuses a tab kind whose identity is missing or the wrong type', () => {
    expect(parseTabPayload('{"kind":"note"}')).toBeNull()
    expect(parseTabPayload('{"kind":"note","path":5}')).toBeNull()
    expect(parseTabPayload('{"kind":"note","path":""}')).toBeNull()
    expect(parseTabPayload('{"kind":"app"}')).toBeNull()
    expect(parseTabPayload('{"kind":"app","appId":""}')).toBeNull()
  })

  it('does not let extra keys ride in from the string', () => {
    expect(parseTabPayload('{"kind":"note","path":"a.md","onDrop":"evil"}')).toEqual({
      kind: 'note',
      path: 'a.md',
    })
  })
})
