/**
 * The links' capabilities, as the renderer calls them
 * (`../main/capabilities.ts`).
 */
import { capClient } from '@/plugin-api'
import type { linkCapabilities } from '../main/capabilities'

export const linksCap = capClient<ReturnType<typeof linkCapabilities>>('links')
