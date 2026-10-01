/**
 * The `apps.*` capabilities the plugin's renderer calls: an app's bridge
 * calls, its approvals, its log, and scaffolding one.
 */
import { capClient } from '@/plugin-api'
import type { AppsCapabilities } from '../main/capabilities'

export const appsCap = capClient<AppsCapabilities>('apps')
