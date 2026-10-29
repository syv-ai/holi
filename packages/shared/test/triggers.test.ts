import { describe, expect, it } from 'vitest'
import { parseScheduleFile, scheduleApprovalText, type ScheduleDef } from '../src/schedule'
import { scheduleFileText } from '../src/schedule'
import { interestOf, matchesGlob, parseTriggers, triggerYaml, type Trigger } from '../src/triggers'

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

describe('the editor writing on:', () => {
  const ALL: Trigger[] = [
    { source: 'file', glob: 'inbox/**', changed: false },
    { source: 'file', glob: 'clients/*/brief.md', changed: true },
    { source: 'task', when: 'due', before: 60 },
    { source: 'task', when: 'due', before: 0 },
    { source: 'task', when: 'overdue', before: 0 },
    { source: 'calendar', before: 30 },
    { source: 'mail', query: 'from:@acme.com' },
  ]

  it('writes each trigger in the form it reads back', () => {
    expect(parseTriggers(ALL.map(triggerYaml))).toEqual({ ok: true, triggers: ALL })
  })

  it('sets the list, keeps it when the draft leaves it out, and removes it when empty', () => {
    const base = { name: 'Inbox', crons: [], prompt: 'Sort it.' }
    const written = scheduleFileText({ ...base, on: ALL.slice(0, 1) })
    expect(def(written).on).toEqual(ALL.slice(0, 1))
    const kept = scheduleFileText({ ...base, crons: ['0 9 * * *'] }, written)
    expect(def(kept).on).toEqual(ALL.slice(0, 1))
    const removed = scheduleFileText({ ...base, crons: ['0 9 * * *'], on: [] }, written)
    expect(removed).not.toMatch(/^on:/m)
  })
})
