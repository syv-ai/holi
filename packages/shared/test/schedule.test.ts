import { describe, expect, it } from 'vitest'
import {
  describeScheduleWhen,
  dueRun,
  isScheduleFilePath,
  nextRun,
  parseScheduleFile,
  scheduleApprovalText,
  scheduleSlug,
  type ScheduleDef,
} from '../src/schedule'

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)
const PATH = '.holi/schedules/inbox-triage.md'

const file = (frontmatter: string, body = 'Check my mail.') => `---\n${frontmatter}\n---\n${body}\n`

function def(text: string): ScheduleDef {
  const parsed = parseScheduleFile(text, PATH)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.def
}

function error(text: string): string {
  const parsed = parseScheduleFile(text, PATH)
  if (parsed.ok) throw new Error('expected a refusal')
  return parsed.error
}

describe('schedule paths', () => {
  it('is a markdown file directly in .holi/schedules', () => {
    expect(isScheduleFilePath(PATH)).toBe(true)
    expect(isScheduleFilePath('.holi/schedules/mine.local.md')).toBe(true)
    expect(isScheduleFilePath('.holi/schedules/sub/x.md')).toBe(false)
    expect(isScheduleFilePath('.holi/schedules/notes.txt')).toBe(false)
    expect(isScheduleFilePath('notes/.holi/schedules/x.md')).toBe(false)
  })

  it('names itself by its file, without the local marker', () => {
    expect(scheduleSlug('.holi/schedules/mine.local.md')).toBe('mine')
    expect(scheduleSlug(PATH)).toBe('inbox-triage')
  })
})

describe('parseScheduleFile', () => {
  it('reads a full definition', () => {
    const d = def(
      file(
        [
          'name: Inbox triage',
          'cron: "*/30 7-18 * * 1-5"',
          'model: sonnet',
          'allow:',
          '  - Bash(holi google search:*)',
          '  - Edit',
        ].join('\n'),
        'Look through my unread mail.\n\nDraft replies.',
      ),
    )
    expect(d.name).toBe('Inbox triage')
    expect(d.model).toBe('sonnet')
    expect(d.allow).toEqual(['Bash(holi google search:*)', 'Edit'])
    expect(d.prompt).toBe('Look through my unread mail.\n\nDraft replies.')
    expect(describeScheduleWhen(d.when)).toBe('Every 30 minutes, 07:00–18:59, weekdays')
  })

  it('falls back to the file for a name, and to no rules', () => {
    const d = def(file('cron: "0 9 * * *"'))
    expect(d.name).toBe('inbox-triage')
    expect(d.allow).toEqual([])
    expect(d.model).toBeUndefined()
  })

  it('reads a one-off as a local minute', () => {
    const d = def(file('at: "2026-10-09T15:00"'))
    expect(d.when).toEqual({ kind: 'at', stamp: '2026-10-09T15:00', local: at(2026, 10, 9, 15) })
    expect(describeScheduleWhen(d.when)).toBe('Once, at 2026-10-09 15:00')
  })

  it('refuses what it cannot run, and says why', () => {
    expect(error('Just a prompt.')).toMatch(/frontmatter/)
    expect(error(file('name: x'))).toMatch(/cron.*at/)
    expect(error(file('cron: "0 9 * * *"\nat: "2026-10-09T15:00"'))).toMatch(/not both/)
    expect(error(file('cron: "0 9 * *"'))).toMatch(/five fields/)
    expect(error(file('cron: "* * * * *"'))).toMatch(/more often/)
    expect(error(file('at: 2026-10-09'))).toMatch(/quoted local time/)
    expect(error(file('cron: "0 9 * * *"\nmodel: "--dangerously-skip-permissions"'))).toMatch(
      /model/,
    )
    expect(error(file('cron: "0 9 * * *"\nallow: Bash'))).toMatch(/list/)
    expect(error(file('cron: "0 9 * * *"', ''))).toMatch(/prompt/)
  })
})

describe('scheduleApprovalText', () => {
  it('changes with the prompt, model or rules, and not with the time', () => {
    const base = scheduleApprovalText(def(file('cron: "0 9 * * *"')))
    expect(scheduleApprovalText(def(file('cron: "0 10 * * *"')))).toBe(base)
    expect(scheduleApprovalText(def(file('cron: "0 9 * * *"', 'Other.')))).not.toBe(base)
    expect(scheduleApprovalText(def(file('cron: "0 9 * * *"\nallow: [Edit]')))).not.toBe(base)
    expect(scheduleApprovalText(def(file('cron: "0 9 * * *"\nmodel: opus')))).not.toBe(base)
  })

  it('does not change with the whitespace the commit tidy settles', () => {
    const a = scheduleApprovalText(def(file('cron: "0 9 * * *"', 'Line one. \nLine two.\n\n\n')))
    const b = scheduleApprovalText(def(file('cron: "0 9 * * *"', 'Line one.\nLine two.')))
    expect(a).toBe(b)
  })
})

describe('dueRun and nextRun', () => {
  const every30 = def(file('cron: "*/30 * * * *"')).when

  it('is nothing until a moment passes', () => {
    expect(dueRun(every30, at(2026, 10, 8, 10, 0), at(2026, 10, 8, 10, 29))).toBeNull()
    expect(dueRun(every30, at(2026, 10, 8, 10, 0), at(2026, 10, 8, 10, 30))).toEqual(
      at(2026, 10, 8, 10, 30),
    )
  })

  it('collapses a long sleep into one run', () => {
    expect(dueRun(every30, at(2026, 10, 8, 10, 0), at(2026, 10, 9, 8, 0))).not.toBeNull()
  })

  it('runs a one-off once', () => {
    const once = def(file('at: "2026-10-09T15:00"')).when
    expect(dueRun(once, at(2026, 10, 9, 14), at(2026, 10, 9, 15))).toEqual(at(2026, 10, 9, 15))
    expect(dueRun(once, at(2026, 10, 9, 15), at(2026, 10, 9, 16))).toBeNull()
    expect(nextRun(once, at(2026, 10, 9, 16))).toBeNull()
    expect(nextRun(every30, at(2026, 10, 8, 10, 1))).toEqual(at(2026, 10, 8, 10, 30))
  })
})
