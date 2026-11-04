import { describe, expect, it } from 'vitest'
import {
  addMemoryEntry,
  archiveMemoryEntries,
  fitMemoryBudget,
  loadedMemory,
  MEMORY_MAX_LINES,
  memoryEntry,
  memoryLines,
  removeMemoryEntry,
  searchMemory,
  sinceDate,
  supersedeMemoryEntry,
  topicName,
  withLineEdited,
} from '../src/holi-memory'

describe('a Holi memory entry', () => {
  it('is one dated bullet, secrets redacted', () => {
    expect(memoryEntry('Likes  short\nreplies', '2026-10-04', '2026-11-01')).toBe(
      '- 2026-10-04 · Likes short replies · until 2026-11-01',
    )
    expect(memoryEntry('token: ghp_abcdefghijklmnopqrstuvwx', '2026-10-04')).toContain('«redacted')
    expect(() => memoryEntry('  ', '2026-10-04')).toThrow(/empty/)
    expect(() => memoryEntry('x', '2026-10-04', 'soon')).toThrow(/until/)
  })

  it('is added once, superseded in place and removed only when one line matches', () => {
    const one = memoryEntry('Customer is Nordlys', '2026-10-01')
    let text = addMemoryEntry('', one).text
    expect(addMemoryEntry(text, memoryEntry('Customer is Nordlys', '2026-10-02')).added).toBe(false)
    text = supersedeMemoryEntry(
      text,
      'Nordlys',
      memoryEntry('Customer is Nordlys A/S', '2026-10-04'),
      '2026-10-04',
    )
    expect(text).toBe(
      '- ~~2026-10-01 · Customer is Nordlys~~ · superseded 2026-10-04\n- 2026-10-04 · Customer is Nordlys A/S\n',
    )
    expect(() => removeMemoryEntry(text, 'Elsewhere')).toThrow(/no memory entry/)
    expect(removeMemoryEntry(text, 'A/S').text).not.toContain('A/S')
  })

  it('lists, edits and keeps a person’s own undated lines undated', () => {
    const text = '# Memory\n\n- 2026-10-01 · Dated · until 2026-12-01\n- My own note\n'
    const lines = memoryLines(text)
    expect(lines.map((l) => l.text)).toEqual(['Dated', 'My own note'])
    expect(lines[0]).toMatchObject({ date: '2026-10-01', until: '2026-12-01', struck: false })
    expect(withLineEdited(text, 3, 'Mine, reworded', '2026-10-05')).toContain('- Mine, reworded')
    expect(withLineEdited(text, 2, 'Redated', '2026-10-05')).toContain(
      '- 2026-10-05 · Redated · until 2026-12-01',
    )
  })
})

describe('the memory budget', () => {
  const many = (n: number): string =>
    Array.from({ length: n }, (_, i) => memoryEntry(`fact ${i}`, '2026-10-01')).join('\n') + '\n'

  it('moves struck, then expired, then the oldest out, never a person’s lines', () => {
    const text = `- my own line\n- ~~2026-01-01 · old~~ · superseded 2026-02-01\n${many(MEMORY_MAX_LINES)}`
    const { text: kept, moved } = fitMemoryBudget(text, undefined, '2026-10-21')
    expect(moved[0]).toContain('old')
    expect(kept).toContain('- my own line')
    expect(kept.trim().split('\n')).toHaveLength(MEMORY_MAX_LINES)
    expect(archiveMemoryEntries('', moved, '2026-10-21')).toMatch(
      /^# Archive\n\n.*moved 2026-10-21/,
    )
  })

  it('loads whole lines from the top and counts the rest', () => {
    const { text, dropped } = loadedMemory(many(MEMORY_MAX_LINES + 3))
    expect(text.trim().split('\n')).toHaveLength(MEMORY_MAX_LINES)
    expect(dropped).toBe(3)
  })
})

describe('memory search and topics', () => {
  it('finds lines by words, newest first on a tie', () => {
    const hits = searchMemory(
      [
        {
          file: 'MEMORY.md',
          text: '- 2026-10-01 · Proposal template moved\n- 2026-10-03 · Proposal due Friday\n',
        },
      ],
      'proposal',
    )
    expect(hits.map((h) => h.date)).toEqual(['2026-10-03', '2026-10-01'])
    expect(sinceDate('7d', new Date(2026, 9, 21))).toBe('2026-10-14')
  })

  it('names topics safely', () => {
    expect(topicName('customers.md')).toBe('customers')
    expect(() => topicName('archive')).toThrow()
    expect(() => topicName('../x')).toThrow()
  })
})
