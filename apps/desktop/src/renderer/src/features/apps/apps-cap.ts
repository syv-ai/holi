/** The `apps.*` capabilities Holi's own UI calls: an app's bridge calls, its
 *  approvals, its log, and scaffolding one. */
import { capClient } from '@/lib/cap-client'
import type { AppsCapabilities } from '../../../../main/apps/capabilities'

export const appsCap = capClient<AppsCapabilities>('apps')
