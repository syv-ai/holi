/**
 * The shapes one plugin asks another for over a capability. A plugin never
 * imports another's types, so the asking side types its client from these
 * (`UiCapability` in `capClient`) and the answering plugin's test checks that
 * its own return type is assignable to them.
 */
import type { HoliMascot } from './holi'
import type { ScheduleDraft } from './schedule'

/** `schedules.save`'s draft, as a Holi's first habit writes it. */
export type HabitDraft = Pick<ScheduleDraft, 'name' | 'crons' | 'prompt'> & { holi: string }

/** An automation as a Holi's Habits tab lists it: what `schedules.list` answers. */
export interface HabitSummary {
  path: string
  name: string
  status: 'on' | 'off' | 'changed' | 'invalid'
  holi?: string
  when?: string
  nextRun?: string
  error?: string
}

/** What the automation editor's Holi picker needs of a Holi (`holis.list`). */
export interface PickableHoli {
  id: string
  name: string
  mascot?: HoliMascot
  color?: string
  status: 'approved' | 'new' | 'changed' | 'invalid'
  description?: string
}

/** `tasks.create`'s params, as a thread or an event makes a task. */
export interface TaskCreateDraft {
  title: string
  folder?: string
  description?: string
}
