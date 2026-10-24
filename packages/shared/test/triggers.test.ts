import { describe, expect, it } from 'vitest'
import { parseScheduleFile, scheduleApprovalText, type ScheduleDef } from '../src/schedule'
import { interestOf, matchesGlob, parseTriggers } from '../src/triggers'

const PATH = '.holi/schedules/inbox.local.md'
const file = (frontmatter: string) => `---\n${frontmatter}\n---\nDo it.\n`

function def(text: string): ScheduleDef {
  const parsed = parseScheduleFile(text, PATH)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.def
}

describe('on:', () => {
  it('reads each source, and a schedule with only triggers', () => {
    const d = def(
      file(
        [
          'on:',
          '  - file: inbox/**',
          '  - file: "clients/*/brief.md"',
          '    changed: true',
          '  - task: overdue',
          '  - task: due',
          '    before: 60',
          '  - calendar: 30',
          "  - mail: 'from:@acme.com'",
        ].join('\n'),
      ),
    )
    expect(d.when).toBeUndefined()
    expect(d.on).toEqual([
      { source: 'file', glob: 'inbox/**', changed: false },
      { source: 'file', glob: 'clients/*/brief.md', changed: true },
      { source: 'task', when: 'overdue', before: 0 },
      { source: 'task', when: 'due', before: 60 },
      { source: 'calendar', before: 30 },
      { source: 'mail', query: 'from:@acme.com' },
    ])
    expect(interestOf(d.on)).toEqual({ task: true, calendar: true, mail: ['from:@acme.com'] })
  })

  it('refuses what it cannot fire on, and says why', () => {
    const error = (raw: unknown) => {
      const p = parseTriggers(raw)
      if (p.ok) throw new Error('expected a refusal')
      return p.error
    }
    expect(error('inbox/**')).toMatch(/list/)
    expect(error([{ file: 'a', mail: 'b' }])).toMatch(/one of/)
    expect(error([{ file: '../outside/**' }])).toMatch(/inside the vault/)
    expect(error([{ task: 'soon' }])).toMatch(/due.*overdue/)
    expect(error([{ task: 'overdue', before: 5 }])).toMatch(/before/)
    expect(error([{ calendar: -5 }])).toMatch(/minutes/)
    expect(error([{ mail: 'x', label: 'y' }])).toMatch(/unknown key/)
  })

  it('is part of what turning the schedule on approves', () => {
    const plain = scheduleApprovalText(def(file('cron: "0 9 * * *"')))
    const withFile = scheduleApprovalText(def(file('cron: "0 9 * * *"\non:\n  - file: inbox/**')))
    const withMail = scheduleApprovalText(def(file('cron: "0 9 * * *"\non:\n  - mail: \'x\'')))
    expect(new Set([plain, withFile, withMail]).size).toBe(3)
  })
})

describe('matchesGlob', () => {
  it('keeps * within a folder and lets ** cross them', () => {
    expect(matchesGlob('inbox/**', 'inbox/a.pdf')).toBe(true)
    expect(matchesGlob('inbox/**', 'inbox/x/a.pdf')).toBe(true)
    expect(matchesGlob('inbox/*', 'inbox/x/a.pdf')).toBe(false)
    expect(matchesGlob('**/brief.md', 'brief.md')).toBe(true)
    expect(matchesGlob('**/brief.md', 'clients/acme/brief.md')).toBe(true)
    expect(matchesGlob('clients/*/brief.md', 'clients/acme/brief.md')).toBe(true)
    expect(matchesGlob('inbox/*.pdf', 'inbox/a.md')).toBe(false)
    expect(matchesGlob('inbox/**', 'inboxes/a.pdf')).toBe(false)
  })
})
