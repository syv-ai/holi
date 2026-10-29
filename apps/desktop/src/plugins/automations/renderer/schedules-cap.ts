/**
 * The automations' capabilities, as the renderer calls them
 * (`../main/capabilities.ts`), and the shapes they answer with.
 */
import { capClient } from '@/plugin-api'
import type { scheduleCapabilities } from '../main/capabilities'

export type { RunRecord, ScheduleSummary } from '../main/scheduler'

export const schedulesCap = capClient<ReturnType<typeof scheduleCapabilities>>('schedules')
