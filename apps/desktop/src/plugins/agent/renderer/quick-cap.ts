/**
 * The quick agent's capabilities, as the renderer calls them
 * (`main/quick/capabilities.ts`): its questions, and this machine's settings.
 */
import { capClient } from '@/plugin-api'
import type { quickCapabilities } from '../main/quick/capabilities'

export const quickCap = capClient<ReturnType<typeof quickCapabilities>>('agent')
