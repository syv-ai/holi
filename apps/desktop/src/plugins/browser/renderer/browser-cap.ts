/**
 * The browser's capabilities, as the renderer calls them
 * (`../main/capabilities.ts`).
 */
import { capClient } from '@/plugin-api'
import type { browserCapabilities, browserHintCapabilities } from '../main/capabilities'

export const browserCap = capClient<ReturnType<typeof browserCapabilities>>('browser')

export const browserHintCap = capClient<ReturnType<typeof browserHintCapabilities>>('browser')
