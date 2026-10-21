import { describe, expect, test } from 'vitest'
import { holiLink, holiLinkInArgv, parseHoliLink } from '../src/holi-link'

const parsed = (raw: string) => {
  const result = parseHoliLink(raw)
  return result.ok ? result.link : null
}

describe('holiLink and parseHoliLink', () => {
  test('a link reads back as what it was built from', () => {
    const links = [
      { remote: 'syv-ai/team.notes', path: 'notes/plan.md' },
      { remote: 'a/b', path: 'Projekter/Q3 plan & budget #2.md', heading: 'next-steps' },
      { remote: 'a/b', path: 'notes/100% + æøå?.md', heading: 'Hvad så?' },
    ]
    for (const link of links) expect(parsed(holiLink(link))).toEqual(link)
  })

  test('the vault and path stay legible', () => {
    expect(holiLink({ remote: 'a/b', path: 'notes/my plan.md' })).toBe(
      'holi://open?vault=a/b&path=notes/my%20plan.md',
    )
  })

  test('the path is normalized', () => {
    expect(parsed('holi://open?vault=a/b&path=./notes//plan.md')?.path).toBe('notes/plan.md')
  })

  test('a path and heading read in one Unicode form, however they were typed', () => {
    const nfd = 'Caf\u0065\u0301'
    const link = parsed(holiLink({ remote: 'a/b', path: `${nfd}.md`, heading: nfd }))
    expect(link).toEqual({ remote: 'a/b', path: 'Caf\u00e9.md', heading: 'Caf\u00e9' })
    expect(parsed(`holi://open?vault=a/b&path=${encodeURIComponent(`${nfd}.md`)}`)?.path).toBe(
      'Caf\u00e9.md',
    )
  })

  test('refuses what is not a well-formed link to a vault file', () => {
    for (const raw of [
      'not a url',
      'https://open?vault=a/b&path=x.md',
      'holi://run?vault=a/b&path=x.md',
      'holi://open/elsewhere?vault=a/b&path=x.md',
      'holi://open?path=x.md',
      'holi://open?vault=../etc&path=x.md',
      'holi://open?vault=a/b',
      'holi://open?vault=a/b&path=../outside.md',
      'holi://open?vault=a/b&path=/etc/passwd',
      'holi://open?vault=a/b&path=.git/config',
      'holi://open?vault=a/b&path=apps/x/node_modules/pkg/README.md',
      `holi://open?vault=a/b&path=x.md&heading=${'h'.repeat(201)}`,
    ]) {
      expect(parseHoliLink(raw).ok, raw).toBe(false)
    }
  })

  test('refuses a file that never leaves one machine', () => {
    for (const path of [
      'USER.local.md',
      '.env',
      'apps/Home.local.app/index.html',
      '.holi/state/x',
    ]) {
      expect(parseHoliLink(holiLink({ remote: 'a/b', path })).ok, path).toBe(false)
    }
  })
})

describe('holiLinkInArgv', () => {
  test('finds the link among the arguments', () => {
    expect(holiLinkInArgv(['/Applications/Holi', '--flag', 'holi://open?vault=a/b'])).toBe(
      'holi://open?vault=a/b',
    )
    expect(holiLinkInArgv(['/Applications/Holi', 'HOLI://open?vault=a/b'])).toBe(
      'HOLI://open?vault=a/b',
    )
    expect(holiLinkInArgv(['/Applications/Holi', '.'])).toBeNull()
  })
})
