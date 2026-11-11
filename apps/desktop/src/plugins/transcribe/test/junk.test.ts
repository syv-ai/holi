/**
 * What nobody said: timestamp loops, the microphone's echo of the speakers,
 * and short bursts of broadcast cliché, each against lines like the ones a
 * real meeting on laptop speakers gave (the text invented).
 */
import { describe, expect, it } from 'vitest'
import { transcribe, type Fetch } from '../main/asr'
import { compressionRatio, dropHallucinations, isTimestampLoop, similarity } from '../main/junk'
import { chunkSegments, stitch, type ChunkSegment } from '../main/stitcher'

const line = (
  speaker: 'Me' | 'Them',
  start: number,
  end: number,
  text: string,
  over: Partial<ChunkSegment> = {},
): ChunkSegment => ({ speaker, start, end, text, chunk: 0, ...over })

const kept = (lines: ChunkSegment[], earlier: ChunkSegment[] = []) =>
  dropHallucinations(lines, earlier).kept.map((s) => s.text)

const reasons = (lines: ChunkSegment[], earlier: ChunkSegment[] = []) =>
  dropHallucinations(lines, earlier).dropped.map((d) => [d.segment.text, d.reason])

/** A long line of speech on a channel, far from the bursts under test. */
const talk = (speaker: 'Me' | 'Them', start: number) =>
  line(speaker, start, start + 6, 'Vi skal have kigget på planen for næste uge, synes jeg.')

describe('loops', () => {
  it('drops subtitle timestamps, cue after cue', () => {
    const loop = '12:01: Helt vildt. * 13:01: Helt vildt. * 14:01: Helt vildt. *'
    expect(isTimestampLoop(loop)).toBe(true)
    expect(isTimestampLoop('05:03 helt vildt 06:03 helt vildt')).toBe(true)
    expect(reasons([line('Them', 0, 9, loop)])).toEqual([[loop, 'timestamp loop']])
  })

  it('keeps a line that says times', () => {
    for (const text of [
      'Vi flytter mødet fra 10:00 til 11:30.',
      'Fra 10:00 til 11:30, og så igen fra 13:00 til 14:00 og så videre.',
      'Klokken 9:15 starter vi.',
    ]) {
      expect(isTimestampLoop(text)).toBe(false)
      expect(kept([line('Me', 0, 4, text)])).toEqual([text])
    }
  })

  it('drops a line the service measured past 2.4, and keeps one under', () => {
    const text = 'Det var en rigtig god dag, og vi fik lavet rigtig meget.'
    expect(reasons([line('Them', 0, 5, text, { compression: 2.9 })])).toEqual([
      [text, 'compression ratio 2.90'],
    ])
    expect(kept([line('Them', 0, 5, text, { compression: 1.1 })])).toEqual([text])
  })

  it('measures the ratio itself when the service gave none', () => {
    const loop = `Og så sagde hun ${'hahaha'.repeat(30)}`
    expect(compressionRatio(loop)).toBeGreaterThan(2.4)
    expect(compressionRatio('Det var en god dag, og vi fik lavet meget.')).toBeLessThan(2.4)
    expect(reasons([line('Them', 0, 5, loop)])[0]?.[1]).toMatch(/^compression ratio /)
  })

  it("keeps the service's ratio as it reads a segment", async () => {
    const fetch: Fetch = async () =>
      Response.json({
        segments: [{ start: 0, end: 2, text: 'Hej med dig', compression_ratio: 0.8 }],
      })
    const segs = await transcribe(fetch, {
      service: { url: null, model: null },
      wav: new Uint8Array(),
      apiKey: 'test',
      model: 'm',
      language: 'da',
      diarize: false,
      vocab: [],
      duration: 2,
    })
    expect(segs[0]?.compression).toBe(0.8)
    const [chunked] = chunkSegments(segs, { n: 0, start: 0, duration: 2 }, () => 'Me')
    expect(chunked?.compression).toBe(0.8)
  })

  it('forgets the ratio of a loop it collapsed: what is left is measured again', () => {
    const [s] = chunkSegments(
      [{ start: 0, end: 5, text: 'ja tak ja tak ja tak ja tak', compression: 3 }],
      { n: 0, start: 0, duration: 5 },
      () => 'Me',
    )
    expect(s?.text).toBe('ja tak')
    expect(s?.compression).toBeUndefined()
  })
})

describe('echo', () => {
  const them = 'Udover at appen også kan gemme noterne selv, så er det smart, når man rejser.'
  const echo = 'At appen også kan gemme noterne af sig selv, så den gemmer alt deroppe eller ja.'

  it('drops the microphone hearing the speakers, and keeps the computer’s own copy', () => {
    expect(similarity(them, echo)).toBeGreaterThanOrEqual(0.3)
    const lines = [line('Them', 87.1, 92.9, them), line('Me', 87.1, 93.3, echo)]
    expect(kept(lines)).toEqual([them])
    expect(reasons(lines)[0]?.[1]).toMatch(/^echo of Them at 87\.1s/)
  })

  it('keeps two people talking over each other', () => {
    const a = 'Jeg tror vi skal starte med budgettet, før vi taler om lønnen.'
    const b = 'Ja, men det kræver at vi har tallene fra salg i hånden først.'
    expect(similarity(a, b)).toBeLessThan(0.3)
    expect(kept([line('Them', 10, 16, a), line('Me', 10.5, 16, b)])).toEqual([a, b])
  })

  it('keeps a long Me line that a short Them line shares a few words with', () => {
    const me = 'For at lave den næste rapport.'
    const short = 'For at lave sin sang.'
    expect(similarity(me, short)).toBeGreaterThanOrEqual(0.3)
    expect(kept([line('Me', 67, 72, me), line('Them', 70.5, 72, short)])).toEqual([me, short])
  })

  it('keeps the same words said at different times', () => {
    expect(kept([line('Them', 0, 3, them), line('Me', 4, 7, them)])).toEqual([them, them])
  })
})

describe('bursts', () => {
  it.each([
    ['TV 2', 1.2],
    ['TV2 News', 1.4],
    ['DR P3', 1],
    ['P4', 0.8],
    ['Næste station', 1.5],
    ['Odense centrum', 1.8],
    ['Aarhus H', 1.1],
    ['Nørreport station', 1.6],
    ['[Musik]', 2],
    ['Det er den sidste station i Vejle.', 2.1],
    ['Næste stop: Nørreport.', 1.9],
  ])('drops %j alone on its channel, %s s long', (text, seconds) => {
    expect(reasons([line('Them', 50, 50 + seconds, text)])).toEqual([
      [text, `broadcast cliché, ${seconds.toFixed(1)}s`],
    ])
  })

  it.each([
    'Jeg så det på TV 2 i går.',
    'Vi mødes ved Odense centrum klokken tre.',
    'Hvad siger du?',
    'Resultatet på den anden side',
  ])('keeps %j, short and alone', (text) => {
    expect(kept([line('Them', 50, 51.8, text)])).toEqual([text])
  })

  it('keeps a cliché as long as speech is', () => {
    expect(kept([line('Them', 50, 53, 'Odense centrum')])).toEqual(['Odense centrum'])
  })

  it('keeps a place that ends what its speaker was saying', () => {
    const lines = [
      line('Them', 40, 44.5, 'Så tager vi toget i morgen tidlig og står af ved'),
      line('Them', 45, 46.5, 'Odense centrum'),
    ]
    expect(kept(lines)).toEqual(lines.map((s) => s.text))
  })

  it('drops an announcement even right after speech on its channel', () => {
    const lines = [talk('Them', 88), line('Them', 94.4, 96.5, 'Det er den sidste station i Vejle.')]
    expect(kept(lines)).toEqual([lines[0]!.text])
  })

  it('drops one or two words under 1.5 s with nobody speaking within 3 s', () => {
    expect(reasons([talk('Me', 0), line('Me', 20, 20.8, 'Okay.')])).toEqual([
      ['Okay.', 'lone burst, 0.8s'],
    ])
  })

  it('keeps a lone "ja" in conversation: the other side spoke just before', () => {
    const lines = [talk('Them', 10), line('Me', 17.5, 18.1, 'Ja.')]
    expect(kept(lines)).toEqual([lines[0]!.text, 'Ja.'])
  })

  it('keeps a short line next to more from its own speaker', () => {
    const lines = [talk('Me', 10), line('Me', 17.5, 18.3, 'For resten.')]
    expect(kept(lines)).toEqual([lines[0]!.text, 'For resten.'])
  })

  it('hears the conversation in the chunk before', () => {
    expect(kept([line('Me', 20.5, 21, 'Ja.', { chunk: 3 })], [talk('Them', 13)])).toEqual(['Ja.'])
  })

  it('keeps three words or more, however short', () => {
    expect(kept([line('Them', 50, 50.9, 'Hvad siger du?')])).toEqual(['Hvad siger du?'])
  })
})

describe('as a chunk is stitched', () => {
  it('gives what nobody said no index, and says why it went', () => {
    const chunk = (n: number, lines: ChunkSegment[]) => lines.map((s) => ({ ...s, chunk: n }))
    const { state, dropped } = stitch({
      segments: [],
      next: 0,
      pending: {
        0: chunk(0, [talk('Them', 0)]),
        1: chunk(1, [
          line('Them', 12, 13.2, 'TV 2'),
          line('Me', 13.5, 19, 'Nu prøver vi at dele skærmen igen.'),
        ]),
      },
    })
    expect(state.segments.map((s) => [s.i, s.text])).toEqual([
      [0, 'Vi skal have kigget på planen for næste uge, synes jeg.'],
      [1, 'Nu prøver vi at dele skærmen igen.'],
    ])
    expect(dropped.map((d) => [d.segment.text, d.reason])).toEqual([
      ['TV 2', 'broadcast cliché, 1.2s'],
    ])
    expect(state.segments.every((s) => !('compression' in s))).toBe(true)
  })
})
