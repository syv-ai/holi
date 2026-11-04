/**
 * Links' main side (docs/features/links.md): the link files it claims in the
 * snapshot, the skill it seeds, and its capabilities, with the previews they
 * fetch cached on this machine across every vault.
 */
import type { MainPlugin } from '../../../main/plugin-api'
import { LINKS_INFO } from '../info'
import { linkClaim } from '../shared/link-file'
import { previewCache, type PreviewCache } from './cache'
import { linkCapabilities, LINKS_NAMESPACES } from './capabilities'
import { linksSeed } from './seed'
import { fetchPreview } from './unfurl'

/** One cache for the machine: a page looks the same from every vault. */
let cache: PreviewCache | null = null

export const linksMain: MainPlugin = {
  info: LINKS_INFO,
  seed: linksSeed,
  claims: [linkClaim],
  activate(ctx) {
    cache ??= previewCache(ctx.userData, (url) => fetchPreview(url))
    const previews = cache
    return ctx.register(LINKS_NAMESPACES, linkCapabilities({ preview: (url) => previews.get(url) }))
  },
}
