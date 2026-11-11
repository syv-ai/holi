/**
 * The meeting engine's capabilities, as the renderer calls them
 * (`../main/capabilities.ts`), and the card patch they take.
 */
import { capClient } from '@/plugin-api'
import type { meetingCapabilities } from '../main/capabilities'

export type { CardPatch } from '../main/cards'

export const meetingCap = capClient<ReturnType<typeof meetingCapabilities>>('meeting')
