/**
 * The stitcher: who spoke (from a synthetic stereo chunk), what is junk, and
 * the order and indices of the transcript.
 */
import { describe, expect, it } from 'vitest'
import { ASR_JUNK, isAsrJunk } from '../main/junk'
import {
  chunkSegments,
  cleanSegments,
  collapseRepeats,
  roomSpeaker,
  speakerOf,
  stitch,
  type ChunkSegment,
  type StitchState,
} from '../main/stitcher'
import { encodeWav, monoWav, parseWav } from '../main/wav'

const RATE = 16_000

/** A stereo chunk: a tone on the left in `me` windows, on the right in
 *  `them` windows (seconds), with a little echo of each on the other side. */
function stereo(seconds: number, me: Array<[number, number]>, them: Array<[number, number]>) {
  const left = new Int16Array(seconds * RATE)
  const right = new Int16Array(seconds * RATE)
  const tone = (ch: Int16Array, echo: Int16Array, [a, b]: [number, number]) => {
    for (let i = a * RATE; i < b * RATE; i++) {
      const v = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE))
      ch[i] = v
      echo[i] = Math.round(v / 6)
    }
  }
  for (const w of me) tone(left, right, w)
  for (const w of them) tone(right, left, w)
  return parseWav(encodeWav(RATE, [left, right]))
}

const seg = (over: Partial<ChunkSegment>): ChunkSegment => ({
  speaker: 'Me',
  start: 0,
  end: 1,
  text: 'hej',
  chunk: 0,
  ...over,
})

describe('who spoke', () => {
  it('labels a window by its louder channel: the mic is Me, the computer is Them', () => {
    const pcm = stereo(6, [[0, 2]], [[3, 5]])
    expect(speakerOf(pcm, 0, 2)).toBe('Me')
    expect(speakerOf(pcm, 3, 5)).toBe('Them')
    // Silence on both sides is Me: without the computer's sound everything is.
    expect(speakerOf(pcm, 5.5, 6)).toBe('Me')
  })

  it('labels each segment of a chunk from the stereo audio', () => {
    const pcm = stereo(6, [[0, 2]], [[3, 5]])
    const segs = chunkSegments(
      [
        { start: 0.1, end: 1.9, text: 'Jeg tænker vi skal have eksport.' },
        { start: 3.1, end: 4.9, text: 'Ja, til CSV.' },
      ],
      { n: 2, start: 20, duration: 6 },
      (_s, from, to) => speakerOf(pcm, from, to),
    )
    expect(segs.map((s) => [s.speaker, s.start, s.end, s.chunk])).toEqual([
      ['Me', 20.1, 21.9, 2],
      ['Them', 23.1, 24.9, 2],
    ])
  })

  it('a mono file is all Me, and its mix is itself', () => {
    const mono = parseWav(encodeWav(RATE, [new Int16Array(RATE).fill(1000)]))
    expect(speakerOf(mono, 0, 1)).toBe('Me')
    expect(parseWav(monoWav(mono)).left[0]).toBe(1000)
  })

  it('mixes stereo down to the average of the channels', () => {
    const pcm = parseWav(
      encodeWav(RATE, [new Int16Array([1000, -2000]), new Int16Array([3000, 0])]),
    )
    const mono = parseWav(monoWav(pcm))
    expect(mono.channels).toBe(1)
    expect([...mono.left]).toEqual([2000, -1000])
  })

  it("reads the service's speaker labels as Speaker N for a room", () => {
    expect(roomSpeaker(0)).toBe('Speaker 1')
    expect(roomSpeaker('SPEAKER_00')).toBe('Speaker 1')
    expect(roomSpeaker('speaker_1')).toBe('Speaker 2')
    expect(roomSpeaker('B')).toBe('Speaker 2')
    expect(roomSpeaker(undefined)).toBe('Speaker 1')
  })

  it('clamps segment times to the chunk', () => {
    const [s] = chunkSegments(
      [{ start: -1, end: 99, text: 'lang' }],
      { n: 0, start: 10, duration: 8 },
      () => 'Me',
    )
    expect([s!.start, s!.end]).toEqual([10, 18])
  })
})

describe('junk', () => {
  it.each([
    'DR P1',
    'DR P4 Fælles',
    'DR1',
    'P2:',
    'Tekster af Lise Jensen',
    'Tekstet af Dansk Video Tekst',
    'Undertekster af Nicolai Winther',
    'Undertekstning: DR',
    '  "DR P3."  ',
    'Thanks for watching!',
  ])('drops %j', (text) => {
    expect(isAsrJunk(text)).toBe(true)
  })

  it.each([
    'Vi skal tale med DR om licensen.',
    'P2 er vores næste prioritet, ikke?',
    'Teksten skal være kortere.',
    'Tak for i dag.',
  ])('keeps speech that only mentions it: %j', (text) => {
    expect(isAsrJunk(text)).toBe(false)
  })

  it('is one list', () => {
    expect(ASR_JUNK.length).toBeGreaterThan(3)
  })

  it('drops junk segments from a chunk', () => {
    const out = cleanSegments([seg({ text: 'Undertekster af X' }), seg({ text: 'Godt.' })])
    expect(out.map((s) => s.text)).toEqual(['Godt.'])
  })
})

describe('repetition', () => {
  it('collapses a phrase looping three times or more', () => {
    expect(collapseRepeats('ja ja ja ja ja')).toBe('ja')
    expect(collapseRepeats('Vi ses. Vi ses. Vi ses. Vi ses.')).toBe('Vi ses.')
    expect(collapseRepeats('det er det er det er fint')).toBe('det er fint')
  })

  it('keeps a word said twice, as people do', () => {
    expect(collapseRepeats('nej nej, det går ikke')).toBe('nej nej, det går ikke')
  })

  it('drops a segment that repeats the one before it in a loop', () => {
    const loop = 'Og så skal vi have eksporten med i næste sprint.'
    const out = cleanSegments([
      seg({ text: loop }),
      seg({ text: loop, start: 2 }),
      seg({ text: loop, start: 4 }),
      seg({ text: 'Ja.', start: 6 }),
      seg({ text: 'Ja.', start: 7 }),
    ])
    expect(out.map((s) => s.text)).toEqual([loop, 'Ja.', 'Ja.'])
  })
})

describe('order', () => {
  const empty: StitchState = { segments: [], next: 0, pending: {} }
  const two = (n: number): ChunkSegment[] => [
    seg({ chunk: n, start: n * 10 + 5, end: n * 10 + 7, text: `b${n}` }),
    seg({ chunk: n, start: n * 10, end: n * 10 + 2, text: `a${n}` }),
  ]

  it('holds a chunk until every earlier one is in, then numbers in order', () => {
    let { state, added } = stitch({ ...empty, pending: { 1: two(1) } })
    expect(added).toEqual([])
    ;({ state, added } = stitch({ ...state, pending: { ...state.pending, 0: two(0) } }))
    expect(added.map((s) => [s.i, s.text])).toEqual([
      [0, 'a0'],
      [1, 'b0'],
      [2, 'a1'],
      [3, 'b1'],
    ])
    expect(state.next).toBe(2)
    expect(state.pending).toEqual({})
  })

  it('never changes an index once given', () => {
    let { state } = stitch({ ...empty, pending: { 0: two(0) } })
    const first = state.segments.map((s) => ({ ...s }))
    ;({ state } = stitch({ ...state, pending: { 2: two(2), 1: two(1) } }))
    expect(state.segments.slice(0, 2)).toEqual(first)
    expect(state.segments.map((s) => s.i)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('passes over a chunk that failed for good', () => {
    const { state } = stitch(
      { ...empty, pending: { 0: two(0), 2: two(2) } },
      { skip: new Set([1]) },
    )
    expect(state.segments.map((s) => s.text)).toEqual(['a0', 'b0', 'a2', 'b2'])
  })

  it('stitches past a gap once the meeting is over', () => {
    const { state } = stitch({ ...empty, pending: { 0: two(0), 3: two(3) } }, { final: true })
    expect(state.segments.map((s) => [s.i, s.chunk])).toEqual([
      [0, 0],
      [1, 0],
      [2, 3],
      [3, 3],
    ])
  })
})
