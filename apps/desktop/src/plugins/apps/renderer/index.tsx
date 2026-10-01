/**
 * Vault apps' renderer side (docs/features/vault-apps.md). The app surface,
 * its claim and its rail item are still core's, until they move here.
 */
import type { RendererPlugin } from '@/plugin-api'
import { APPS_INFO } from '../info'

export const appsRenderer: RendererPlugin = {
  info: APPS_INFO,
}
