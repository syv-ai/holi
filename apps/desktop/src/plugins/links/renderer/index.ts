/**
 * Links' renderer side (docs/features/links.md): the link-file claim, which
 * makes New Link and a dropped address into link files, and shows a link's
 * page as a card on its row and at the top of its tab.
 */
import type { RendererPlugin } from '@/plugin-api'
import { LINKS_INFO } from '../info'
import { LINK_PATH_CLAIM } from './claim'

export const linksRenderer: RendererPlugin = {
  info: LINKS_INFO,
  claims: [LINK_PATH_CLAIM],
}
