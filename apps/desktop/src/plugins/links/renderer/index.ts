/**
 * Links' renderer side (docs/features/links.md): the link-file claim, the
 * marks link files carry in the tree and the tabs, and the card over any
 * web address in a note.
 */
import type { RendererPlugin } from '@/plugin-api'
import { LINKS_INFO } from '../info'
import { LINK_PATH_CLAIM, linkMarksAtom } from './claim'
import { urlHover } from './url-hover'
import { setLinksRemote } from './use-preview'

export const linksRenderer: RendererPlugin = {
  info: LINKS_INFO,
  claims: [LINK_PATH_CLAIM],
  pathMarks: linkMarksAtom,
  editorExtensions: urlHover,
  vault(remote) {
    setLinksRemote(remote)
    return () => setLinksRemote(null)
  },
}
