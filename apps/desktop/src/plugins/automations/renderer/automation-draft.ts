/**
 * What the automation editor holds while it is open, and how it starts from
 * an automation (or a blank one).
 */
import { useMemo } from 'react'
import { triggerOfCron, type ScheduleTrigger, type Trigger } from '@holi/shared'
import { type ScheduleSummary } from './schedules-cap'

/** What the editor holds while it is open. */
export interface Draft {
  name: string
  active: boolean
  triggers: ScheduleTrigger[]
  /** The events that start it, the file's `on:`. */
  on: Trigger[]
  holi?: string
  model?: string
  allow: string[]
  catchUpMinutes?: number
  prompt: string
}

/** A new automation, after MonoCode's defaults: weekdays at 09:00, active. */
function blankDraft(holi?: string): Draft {
  return {
    name: '',
    active: true,
    triggers: [{ kind: 'weekdays', time: '09:00' }],
    on: [],
    ...(holi === undefined ? {} : { holi }),
    allow: [],
    prompt: '',
  }
}

/** @public exported for its test */
export function draftOf(s: ScheduleSummary): Draft {
  return {
    name: s.name,
    active: s.status === 'on',
    triggers: (s.crons ?? []).map(triggerOfCron),
    on: s.on ?? [],
    ...(s.holi === undefined ? {} : { holi: s.holi }),
    ...(s.model === undefined ? {} : { model: s.model }),
    allow: s.allow ?? [],
    ...(s.catchUpMinutes === undefined ? {} : { catchUpMinutes: s.catchUpMinutes }),
    prompt: s.prompt ?? '',
  }
}

export const same = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b)

/** The editor keyed by what it edits, so opening another starts fresh. */
export function useInitialDraft(summary: ScheduleSummary | undefined, holi?: string): Draft {
  return useMemo(
    () => (summary === undefined ? blankDraft(holi) : draftOf(summary)),
    // Re-read when main's view of it moves (a save, a run, a pull).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary === undefined ? `new:${holi ?? ''}` : JSON.stringify(summary)],
  )
}
