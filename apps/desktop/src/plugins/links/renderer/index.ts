/**
 * Links' renderer side (docs/features/links.md). Saving a web address as a
 * link file, and its preview card, run in main; the screens for them in the
 * new editor and files list are not built yet (docs/not-built.md).
 */
import type { RendererPlugin } from '@/plugin-api'
import { LINKS_INFO } from '../info'

export const linksRenderer: RendererPlugin = {
  info: LINKS_INFO,
}
