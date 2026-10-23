/**
 * The automations plugin's `schedules.save`, asked by name: a plugin cannot
 * import another's types, so the shape is written here and main checks it.
 * The wizard writes a new Holi's first habit through it, the same door the
 * automation editor's Create uses, and it approves nothing.
 */
import { capClient, type UiCapability } from '@/plugin-api'

export interface HabitDraft {
  name: string
  /** One cron per trigger, in this machine's local time. */
  crons: string[]
  prompt: string
  holi: string
}

export const habitsCap = capClient<{
  'schedules.save': UiCapability<{ draft: HabitDraft }, { path: string }>
}>('schedules')
