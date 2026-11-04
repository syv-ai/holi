/**
 * The automations plugin's `schedules.list` and `schedules.save`, asked by
 * name: a plugin cannot import another's types, so the shapes come from
 * `@holi/shared` (`plugin-wire.ts`) and the automations' test checks its own
 * answers fit them. The Habits tab lists through it; the wizard writes a new
 * Holi's first habit through it, the same door the automation editor's Create
 * uses, and it approves nothing.
 */
import type { HabitDraft, HabitSummary } from '@holi/shared'
import { capClient, type UiCapability } from '@/plugin-api'

export const habitsCap = capClient<{
  'schedules.list': UiCapability<void, HabitSummary[]>
  'schedules.save': UiCapability<{ draft: HabitDraft }, { path: string }>
}>('schedules')
