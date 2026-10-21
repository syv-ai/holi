/**
 * The automations' capabilities, as the renderer calls them
 * (`../main/capabilities.ts`), and the shapes they answer with. Types only
 * from main: a value import would bundle main-process code into the renderer.
 */
import { capClient } from '@/plugin-api'
import type { scheduleCapabilities } from '../main/capabilities'

export type { RunRecord, ScheduleStatus, ScheduleSummary } from '../main/scheduler'

export const schedulesCap = capClient<ReturnType<typeof scheduleCapabilities>>('schedules')
