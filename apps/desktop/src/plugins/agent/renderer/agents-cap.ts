/**
 * Holis' capabilities, as the renderer calls them (`main/holis/capabilities.ts`),
 * and the shapes they answer with. Types only from main: a value import would
 * bundle main-process code into the renderer.
 */
import { capClient } from '@/plugin-api'
import type { holiCapabilities } from '../main/holis/capabilities'

export type { HoliRun, HoliSummary, RunReport } from '../main/holis/holis'

export const holiCap = capClient<ReturnType<typeof holiCapabilities>>('holis')
