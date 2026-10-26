import { HOLI_MASCOTS, LEGACY_HOLI_MASCOTS } from '@holi/shared'
import { describe, expect, it } from 'vitest'
import {
  HEAD_CROP,
  PERSONA_GRID,
  PERSONAS,
  TALL_LIFT,
  drawPersona,
  personaId,
  personaRuns,
  type Frame,
  type Run,
} from '../personas'

const REST: Frame = { pose: 'rest', mouth: 'smile', blink: false }
const FRAMES: Frame[] = [
  REST,
  { pose: 'rest', mouth: 'open', blink: true },
  { pose: 'waveA', mouth: 'closed', blink: false },
  { pose: 'waveB', mouth: 'smile', blink: false },
]

/** Every painted pixel of a frame, as `x,y` → colour. */
function pixels(runs: readonly Run[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of runs) for (let x = r.x; x < r.x + r.w; x++) out.set(`${x},${r.y}`, r.fill)
  return out
}

describe('pixel personas', () => {
  it('has a look for every character, and nothing that names a person', () => {
    expect(Object.keys(PERSONAS).sort()).toEqual([...HOLI_MASCOTS].sort())
    for (const p of Object.values(PERSONAS)) {
      expect(Object.keys(p).sort()).not.toContain('lines')
      expect(Object.keys(p.hero).sort()).toEqual(['cape', 'emblem', 'mask', 'suit'])
    }
  })

  it('draws the same frame the same way every time', () => {
    for (const id of HOLI_MASCOTS) {
      for (const frame of FRAMES) {
        for (const hero of [false, true]) {
          const a = drawPersona(PERSONAS[id], frame, hero)
          expect(drawPersona(PERSONAS[id], { ...frame }, hero)).toEqual(a)
        }
      }
    }
  })

  it('stays on its grid, a tall one rising above it', () => {
    for (const id of HOLI_MASCOTS) {
      const runs = drawPersona(PERSONAS[id], REST, true)
      const top = Math.min(...runs.map((r) => r.y))
      for (const r of runs) {
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(PERSONA_GRID)
        expect(r.y).toBeLessThan(PERSONA_GRID)
        expect(r.fill).toMatch(/^#[0-9a-f]{6}$/)
      }
      if (PERSONAS[id].tall) expect(top).toBeLessThan(0)
      else expect(top).toBeGreaterThanOrEqual(0)
      expect(top).toBeGreaterThanOrEqual(-TALL_LIFT)
    }
  })

  it('merges a row into runs that never touch in the same colour', () => {
    const runs = drawPersona(PERSONAS.captain, REST)
    for (let i = 1; i < runs.length; i++) {
      const [a, b] = [runs[i - 1]!, runs[i]!]
      if (a.y === b.y) {
        expect(b.x).toBeGreaterThanOrEqual(a.x + a.w)
        if (b.x === a.x + a.w) expect(b.fill).not.toBe(a.fill)
      }
    }
  })

  it('suits up in the dark: the same face, a different body', () => {
    const plain = pixels(drawPersona(PERSONAS.captain, REST, false))
    const hero = pixels(drawPersona(PERSONAS.captain, REST, true))
    expect(hero.get('16,26')).not.toBe(plain.get('16,26'))
    // The cape spreads past the shoulders.
    expect(plain.has('2,30')).toBe(false)
    expect(hero.has('2,30')).toBe(true)
  })

  it('only moves the eyes to blink, and the mouth to talk', () => {
    const base = pixels(drawPersona(PERSONAS.scout, REST))
    const blink = pixels(drawPersona(PERSONAS.scout, { ...REST, blink: true }))
    const talk = pixels(drawPersona(PERSONAS.scout, { ...REST, mouth: 'open' }))
    const changed = (other: Map<string, string>) =>
      [...new Set([...base.keys(), ...other.keys()])].filter((k) => base.get(k) !== other.get(k))
    for (const k of changed(blink)) expect(Number(k.split(',')[1])).toBeGreaterThanOrEqual(12)
    for (const k of changed(blink)) expect(Number(k.split(',')[1])).toBeLessThanOrEqual(13)
    for (const k of changed(talk)) expect(Number(k.split(',')[1])).toBeGreaterThanOrEqual(16)
  })

  it('crops the head and shoulders, every head at the same height', () => {
    for (const id of HOLI_MASCOTS) {
      const runs = personaRuns(id, REST, false, 'head')
      for (const r of runs) {
        expect(r.x).toBeGreaterThanOrEqual(HEAD_CROP.x)
        expect(r.x + r.w).toBeLessThanOrEqual(HEAD_CROP.x + HEAD_CROP.size)
        expect(r.y).toBeGreaterThanOrEqual(HEAD_CROP.y)
        expect(r.y).toBeLessThan(HEAD_CROP.y + HEAD_CROP.size)
      }
      // The eyes sit on row 12 whether or not the character is tall.
      expect(pixels(runs).get('13,12')).toBe('#16171a')
    }
  })

  it('draws an older arcade name as its stand-in, anything else as the strategist', () => {
    for (const [old, now] of Object.entries(LEGACY_HOLI_MASCOTS)) {
      expect(personaId(old)).toBe(now)
      expect(personaRuns(old, REST, true)).toEqual(personaRuns(now, REST, true))
    }
    expect(personaId('dragon')).toBe('strategist')
  })
})
