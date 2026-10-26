/**
 * Holis' capabilities, as the renderer calls them (`../main/capabilities.ts`),
 * and the shapes they answer with. Types only from main: a value import would
 * bundle main-process code into the renderer.
 */
import { capClient } from '@/plugin-api'
import type { holiCapabilities } from '../main/capabilities'

export type { HoliEdits, HoliRun, HoliSummary } from '../main/holis'
export type { HoliFiles } from '../main/memory'

export const holiCap = capClient<ReturnType<typeof holiCapabilities>>('holis')
