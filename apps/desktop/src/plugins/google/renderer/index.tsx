/**
 * Google's renderer side (docs/features/google.md). The mail and agenda views
 * are still core's surfaces for now; they move here next.
 */
import type { RendererPlugin } from '@/plugin-api'
import { GOOGLE_INFO } from '../info'

export const googleRenderer: RendererPlugin = {
  info: GOOGLE_INFO,
}
