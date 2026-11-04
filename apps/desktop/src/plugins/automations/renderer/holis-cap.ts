/**
 * The Holis plugin's `holis.list`, asked by name for the Holi picker: a plugin
 * cannot import another's types, so the shape comes from `@holi/shared`
 * (`plugin-wire.ts`) and the Holis' test checks its own answer fits it.
 */
import type { PickableHoli } from '@holi/shared'
import { capClient, type UiCapability } from '@/plugin-api'

export const holisCap = capClient<{ 'holis.list': UiCapability<void, PickableHoli[]> }>('holis')
