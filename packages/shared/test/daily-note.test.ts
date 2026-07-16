import { describe, expect, it } from 'vitest'
import {
  buildDailyNoteContent,
  dailyNoteFilename,
  dailyNoteStem,
  isDailyNote,
  isDailyNoteFilename,
  isUntouchedDailyNote,
} from '../src/daily-note'

const ISO = '2026-07-15'
const STEM = '15-07-2026'

describe('dailyNoteStem / dailyNoteFilename', () => {
  it('formats an ISO date as the zero-padded DD-MM-YYYY stem', () => {
    expect(dailyNoteStem(ISO)).toBe(STEM)
    expect(dailyNoteFilename(ISO)).toBe(`${STEM}.md`)
  })

  it('zero-pads single-digit days and months', () => {
    expect(dailyNoteStem('2026-01-02')).toBe('02-01-2026')
  })

  // The path is the idempotency key (D44/unique index), so a malformed date must
  // never reach the DB as `NaN-NaN-NaN.md` and claim a row.
  it('rejects a malformed or unreal date rather than emitting a junk path', () => {
    expect(() => dailyNoteStem('15-07-2026')).toThrow()
    expect(() => dailyNoteStem('2026-7-5')).toThrow()
    expect(() => dailyNoteStem('2026-02-30')).toThrow()
    expect(() => dailyNoteStem('')).toThrow()
  })
})

describe('buildDailyNoteContent', () => {
  it('seeds type/date frontmatter and a title heading matching the stem', () => {
    expect(buildDailyNoteContent(ISO)).toBe(`---\ntype: daily-note\ndate: ${ISO}\n---\n\n# ${STEM}\n\n`)
  })

  // The seed and the stub heuristic are a matched pair — a note nobody has touched
  // must classify as untouched, or the GC never reaps anything.
  it('produces content the stub heuristic calls untouched', () => {
    expect(isUntouchedDailyNote(buildDailyNoteContent(ISO), dailyNoteStem(ISO))).toBe(true)
  })

  it('produces content isDailyNote recognises', () => {
    expect(isDailyNote(buildDailyNoteContent(ISO))).toBe(true)
  })
})

describe('isDailyNoteFilename (display predicate only — D46)', () => {
  it('matches the DD-MM-YYYY.md shape', () => {
    expect(isDailyNoteFilename('15-07-2026.md')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isDailyNoteFilename('2026-07-15.md')).toBe(false)
    expect(isDailyNoteFilename('15-07-2026.txt')).toBe(false)
    expect(isDailyNoteFilename('1-7-2026.md')).toBe(false)
    expect(isDailyNoteFilename('journal/15-07-2026.md')).toBe(false)
    expect(isDailyNoteFilename('notes.md')).toBe(false)
  })
})

describe('isDailyNote', () => {
  it('detects the type: daily-note frontmatter key', () => {
    expect(isDailyNote('---\ntype: daily-note\ndate: 2026-07-15\n---\n\n# x\n')).toBe(true)
  })

  it('ignores a note without it', () => {
    expect(isDailyNote('---\ntype: note\n---\n\n# x\n')).toBe(false)
    expect(isDailyNote('# just a note\n')).toBe(false)
    // The key must be in the frontmatter, not merely mentioned in the body.
    expect(isDailyNote('# x\n\ntype: daily-note\n')).toBe(false)
  })
})

describe('isUntouchedDailyNote', () => {
  const seeded = (body: string) => `---\ntype: daily-note\ndate: ${ISO}\n---\n${body}`

  it('calls an empty body untouched', () => {
    expect(isUntouchedDailyNote(seeded(''), STEM)).toBe(true)
    expect(isUntouchedDailyNote(seeded('\n\n   \n'), STEM)).toBe(true)
  })

  it('calls a body of only the seeded title untouched', () => {
    expect(isUntouchedDailyNote(seeded(`\n# ${STEM}\n`), STEM)).toBe(true)
    expect(isUntouchedDailyNote(seeded(`\n\n# ${STEM}\n\n`), STEM)).toBe(true)
  })

  it('calls any real writing touched', () => {
    expect(isUntouchedDailyNote(seeded(`\n# ${STEM}\n\nbought milk\n`), STEM)).toBe(false)
    expect(isUntouchedDailyNote(seeded('\nbought milk\n'), STEM)).toBe(false)
  })

  // An edited title is a touch: the body no longer matches what was seeded.
  it('calls a retitled note touched', () => {
    expect(isUntouchedDailyNote(seeded('\n# groceries\n'), STEM)).toBe(false)
    expect(isUntouchedDailyNote(seeded('\n# 16-07-2026\n'), STEM)).toBe(false)
  })

  // The ported guardrail: never delete what cannot be positively classified.
  // Opposite policy to task-file.ts's strict parser, which throws on bad frontmatter.
  it('keeps anything it cannot positively classify', () => {
    expect(isUntouchedDailyNote('', STEM)).toBe(false)
    expect(isUntouchedDailyNote(`# ${STEM}\n`, STEM)).toBe(false)
    expect(isUntouchedDailyNote('---\ntype: daily-note\n', STEM)).toBe(false)
    expect(isUntouchedDailyNote('not a note at all', STEM)).toBe(false)
  })
})
