/**
 * The trigger router: the cases that would catch a real bug. An event fires
 * a schedule once however often it is told, events close together are one
 * run, a moment fires once across checks, and an event while the previous
 * run works is its one follow-up rather than lost or piled up.
 */
import { describe, expect, it } from 'vitest'
import { emptyVaultSnapshot, type Trigger, type VaultEvent } from '@holi/shared'
import { BATCH_MS, createTriggerRouter, describeBatch, fileEvents } from '../main/schedules/router'

const INBOX = {
  path: '.holi/schedules/inbox.md',
  on: [{ source: 'file', glob: 'inbox/**', changed: false }] as Trigger[],
}
const MIN = 60_000

const added = (path: string, version = 'v1'): VaultEvent => ({
  type: 'happened',
  source: 'file',
  kind: 'added',
  id: path,
  version,
  label: `file ${path} added`,
})

describe('the trigger router', () => {
  it('fires once per event however often it is told, and only where a trigger listens', () => {
    const r = createTriggerRouter()
    r.hear(added('inbox/a.pdf'), [INBOX], 0)
    r.hear(added('inbox/a.pdf'), [INBOX], 1_000)
    r.hear(added('notes/b.md'), [INBOX], 1_000)
    expect(r.due(INBOX.path, BATCH_MS, null)).toEqual({ labels: ['file inbox/a.pdf added'] })
    r.take(INBOX.path)
    // Told again after the run: the same version is not new.
    r.hear(added('inbox/a.pdf'), [INBOX], BATCH_MS + 1)
    expect(r.due(INBOX.path, 10 * BATCH_MS, null)).toBeNull()
  })

  it('batches what arrives within the window into one run', () => {
    const r = createTriggerRouter()
    r.hear(added('inbox/a.pdf'), [INBOX], 0)
    r.hear(added('inbox/b.pdf'), [INBOX], 30_000)
    expect(r.due(INBOX.path, 30_000, null)).toBeNull()
    const batch = r.due(INBOX.path, BATCH_MS, null)
    expect(batch?.labels).toEqual(['file inbox/a.pdf added', 'file inbox/b.pdf added'])
  })

  it('holds a batch until the schedule is due again, and keeps it growing meanwhile', () => {
    const r = createTriggerRouter()
    // The previous run started a minute ago: five is the floor.
    r.hear(added('inbox/a.pdf'), [INBOX], 0)
    expect(r.due(INBOX.path, 2 * MIN, -MIN)).toBeNull()
    r.hear(added('inbox/b.pdf'), [INBOX], 3 * MIN)
    expect(r.due(INBOX.path, 4 * MIN, -MIN)?.labels).toHaveLength(2)
  })

  it('fires a moment once, at its time minus the lead', () => {
    const r = createTriggerRouter()
    const s = { path: 'p', on: [{ source: 'calendar', before: 30 }] as Trigger[] }
    const start = 100 * MIN
    r.hear(
      {
        type: 'upcoming',
        source: 'calendar',
        moments: [
          {
            id: 'e1',
            kind: 'starts',
            at: new Date(start).toISOString(),
            label: 'calendar event e1',
          },
        ],
      },
      [s],
      0,
    )
    expect(r.sweep(s, () => 0, 60 * MIN)).toEqual({ calendar: 60 * MIN })
    expect(r.due('p', 70 * MIN, null)).toBeNull()
    // 30 minutes before it starts.
    expect(r.sweep(s, () => 60 * MIN, 71 * MIN)).toEqual({ calendar: 71 * MIN })
    expect(r.due('p', 72 * MIN, null)?.labels).toEqual(['calendar event e1'])
    r.take('p')
    // The watermark moved past it: the next sweep holds nothing.
    r.sweep(s, () => 71 * MIN, 90 * MIN)
    expect(r.due('p', 100 * MIN, null)).toBeNull()
  })

  it("keeps a timed source's watermark until that source has spoken", () => {
    const r = createTriggerRouter()
    const s = { path: 'p', on: [{ source: 'task', when: 'overdue', before: 0 }] as Trigger[] }
    expect(r.sweep(s, () => 0, MIN)).toEqual({})
  })

  it('names five causes and counts the rest', () => {
    const labels = Array.from({ length: 7 }, (_, i) => `file inbox/${i} added`)
    expect(describeBatch({ labels })).toMatch(/inbox\/4 added; and 2 more$/)
  })
})

describe('fileEvents', () => {
  it('tells added and changed files between two scans', () => {
    const before = { ...emptyVaultSnapshot(), files: [{ path: 'inbox/a.pdf', updatedAt: 't1' }] }
    const after = {
      ...emptyVaultSnapshot(),
      files: [
        { path: 'inbox/a.pdf', updatedAt: 't2' },
        { path: 'inbox/b.pdf', updatedAt: 't1' },
      ],
    }
    expect(fileEvents(before, after).map((e) => `${e.kind} ${e.id}`)).toEqual([
      'changed inbox/a.pdf',
      'added inbox/b.pdf',
    ])
    expect(fileEvents(after, after)).toEqual([])
  })
})
